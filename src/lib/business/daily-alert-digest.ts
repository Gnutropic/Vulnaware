// @polsia:user-owned — Business lib for the per-team 09:00 UTC daily
// alert digest. Sits alongside src/lib/business/alerts-digest.ts (the
// 07:00 nightly critical/high digest) with a deliberately different
// scope, link target, and stamp column.
//
// Selection rule (last 24h, EVERY severity, created OR status-changed):
//   - Team.dailyDigestEnabled === true (column default is `true` so
//     legacy rows opt-in post-`prisma db push`; Prisma types the column
//     as non-nullable so a null branch is structurally unreachable).
//   - Alert.teamId IN <active teams>
//   - Alert.OR [createdAt >= now-24h, statusChangedAt >= now-24h]
//   - Hits `@@index([teamId, statusChangedAt])` (added alongside the
//     column) AND `@@index([teamId, createdAt(sort: Desc)])` so the OR'd
//     window scan stays index-only.
//   - Per-severity counts come from a SEPARATE `prisma.alert.groupBy`
//     call so the rendered counts are guaranteed to be `{critical,high,
//     medium,low}` with missing keys defaulting to 0.
//
// Recipient resolution: `WorkspaceMember(workspaceId IN teamIds,
// status='active')` so only onboarded teammates get an email; pending
// invites are excluded by status (mirror alerts-digest.ts:142-153).
//
// Stamp semantics / all-clear branch:
//   - `shouldFireToday(lastSentAt, now)` is the per-UTC-day gate
//     (borrowed from alerts-digest.ts:291-298). A team whose
//     `Team.lastDailyDigestAt` matches today's UTC date returns false
//     and is silently skipped (no envelope, no stamp advance).
//   - Teams with at least one matching row get the populated digest
//     email; teams with zero matching rows BUT at least one active
//     member get the all-clear branch. The `_index` row is consumed
//     by the selector whether we render the populated or all-clear
//     variant — the severity counts map is empty in the all-clear
//     branch but the window bounds are always present.
//   - Teams with zero members are SKIPPED silently — no envelope, no
//     stamp.
//
// fromFor('digest'):
//   - Looked up once and discarded as informational. The proxy binds
//     the actual `From` header at the edge using the per-category map.
//     sendEmail() does not accept a custom `from`; the email proxy
//     intentionally rejects attachments, cc/bcc, and custom From.

import 'server-only';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { dailyAlertAllClearEmail, dailyAlertDigestEmail } from '@/lib/email/templates';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type DailyDigestSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface DailyDigestAlertItem {
  id: string;
  severity: string;
  cveId: string;
  host: string;
  port: number;
}

export interface DailyDigestInput {
  teamId: string;
  teamName: string;
  recipients: string[];
  items: DailyDigestAlertItem[];
  severityCounts: { critical: number; high: number; medium: number; low: number };
  windowStartIso: string;
  windowEndIso: string;
}

export interface SendDailyDigestsOptions {
  appBaseUrl: string;
}

export interface SendDailyDigestsResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  teamResults: DailyDigestRunSummary[];
}

export interface DailyDigestRunSummary {
  teamId: string;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  windowStartIso: string;
  windowEndIso: string;
}

export interface RunDailyDigestForTeamOptions {
  triggeredBy: 'manual';
  appBaseUrl: string;
  // When true (manual trigger), ignores the same-day stamp so the
  // admin button is an explicit re-trigger. Default false so the
  // cron job's gate semantics are preserved.
  force?: boolean;
}

export interface RunDailyDigestForTeamResult {
  id: string | null;
  teamId: string;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  windowStartIso: string;
  windowEndIso: string;
}

interface RawAlertWithFinding {
  id: string;
  teamId: string;
  severity: string | null;
  statusChangedAt: Date | null;
  createdAt: Date;
  finding: { cveId: string; asset: { host: string; port: number } };
}

interface RawTeamRow {
  id: string;
  name: string;
  dailyDigestEnabled: boolean | null;
  lastDailyDigestAt: Date | null;
}

interface RawMemberRow {
  workspaceId: string;
  email: string;
}

const SEVERITIES: DailyDigestSeverity[] = ['critical', 'high', 'medium', 'low'];

// Pure selector. Returns one DailyDigestInput per Team in scope:
//   1. Lifts every Team whose `dailyDigestEnabled === true`.
//   2. Single batched Alert.findMany over that team set, joined into
//      VulnerabilityFinding → Asset so each row carries `cveId`,
//      `host`, `port`. Hits `@@index([teamId, statusChangedAt])` for
//      the OR'd window scan.
//   3. Single batched WorkspaceMember.findMany (active members) for
//      recipients — pending invites excluded by `status`.
//   4. For each team, groups the alerts into the four-severity bucket
//      map (missing keys default to 0) and assembles the input. Empty
//      teams still emit an input with empty arrays; the sender picks
//      all-clear vs populated from `items.length`.
export async function findDailyDigestInputs(now: Date): Promise<DailyDigestInput[]> {
  const teams: RawTeamRow[] = await prisma.team.findMany({
    where: { dailyDigestEnabled: true },
    select: { id: true, name: true, dailyDigestEnabled: true, lastDailyDigestAt: true },
  });
  if (teams.length === 0) return [];

  const teamIds = teams.map((t) => t.id);
  const windowStart = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);

  const alerts: RawAlertWithFinding[] = await prisma.alert.findMany({
    where: {
      teamId: { in: teamIds },
      OR: [{ createdAt: { gte: windowStart } }, { statusChangedAt: { gte: windowStart } }],
    },
    select: {
      id: true,
      teamId: true,
      severity: true,
      statusChangedAt: true,
      createdAt: true,
      finding: { select: { cveId: true, asset: { select: { host: true, port: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Per-severity counts via groupBy so the rendered counts are guaranteed
  // to carry every severity bucket — even teams with zero rows in their
  // window land in the result with their four-bucket map intact (the
  // {critical:0,high:0,medium:0,low:0} default fires when groupBy
  // returns nothing).
  const grouped = await prisma.alert.groupBy({
    by: ['teamId', 'severity'],
    where: {
      teamId: { in: teamIds },
      OR: [{ createdAt: { gte: windowStart } }, { statusChangedAt: { gte: windowStart } }],
    },
    _count: { _all: true },
  });

  const members: RawMemberRow[] = await prisma.workspaceMember.findMany({
    where: { workspaceId: { in: teamIds }, status: 'active' },
    select: { workspaceId: true, email: true },
  });

  const recipientsByTeam = new Map<string, string[]>();
  for (const m of members) {
    if (!m.email) continue;
    const list = recipientsByTeam.get(m.workspaceId) ?? [];
    list.push(m.email);
    recipientsByTeam.set(m.workspaceId, list);
  }

  const alertsByTeam = new Map<string, RawAlertWithFinding[]>();
  for (const a of alerts) {
    const list = alertsByTeam.get(a.teamId) ?? [];
    list.push(a);
    alertsByTeam.set(a.teamId, list);
  }

  const countsByTeam = new Map<string, Map<string, number>>();
  for (const row of grouped) {
    const teamMap = countsByTeam.get(row.teamId) ?? new Map<string, number>();
    const key = (row.severity ?? 'unknown').toLowerCase();
    teamMap.set(key, (teamMap.get(key) ?? 0) + row._count._all);
    countsByTeam.set(row.teamId, teamMap);
  }

  const inputs: DailyDigestInput[] = [];
  for (const team of teams) {
    const teamAlerts = alertsByTeam.get(team.id) ?? [];
    const recipients = recipientsByTeam.get(team.id) ?? [];
    if (recipients.length === 0) continue;

    const teamCounts = countsByTeam.get(team.id) ?? new Map<string, number>();
    const severityCounts = {
      critical: teamCounts.get('critical') ?? 0,
      high: teamCounts.get('high') ?? 0,
      medium: teamCounts.get('medium') ?? 0,
      low: teamCounts.get('low') ?? 0,
    };

    const items: DailyDigestAlertItem[] = teamAlerts.map((a) => ({
      id: a.id,
      severity: (a.severity ?? 'unknown').toLowerCase(),
      cveId: a.finding.cveId,
      host: a.finding.asset.host,
      port: a.finding.asset.port,
    }));

    inputs.push({
      teamId: team.id,
      teamName: team.name,
      recipients,
      items,
      severityCounts,
      windowStartIso: windowStart.toISOString(),
      windowEndIso: now.toISOString(),
    });
  }
  return inputs;
}

// Send the digest queue. Per-team try/catch wraps every sendEmail call
// so one bad team does NOT abort the rest of the batch. The stamp
// advances ONLY when every recipient currently in scope for that team
// sent successfully AND the team was eligible to fire today (no prior
// same-day stamp unless the per-team call sets `force: true`).
//
// Returns the aggregated counters AND a per-team breakdown so the
// batch runner and the manual trigger route can render the same shape.
export async function sendDailyDigests(
  inputs: DailyDigestInput[],
  now: Date,
  options: SendDailyDigestsOptions,
): Promise<SendDailyDigestsResult> {
  if (inputs.length === 0) {
    return {
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      teamResults: [],
    };
  }

  // Informational only — see the file header.
  void fromFor('digest');

  const base = options.appBaseUrl.replace(/\/+$/, '');
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const teamResults: DailyDigestRunSummary[] = [];

  for (const input of inputs) {
    // Same-day idempotency gate — drop teams whose `lastDailyDigestAt`
    // already matches today's UTC calendar date. Skipped is preferred
    // to a 500 so a stalled-but-replayed cron emits a useful deploy
    // log.
    const teamRow = await prisma.team.findUnique({
      where: { id: input.teamId },
      select: { lastDailyDigestAt: true },
    });
    if (teamRow && !shouldFireToday(teamRow.lastDailyDigestAt, now)) {
      skipped += 1;
      teamResults.push({
        teamId: input.teamId,
        severityCounts: input.severityCounts,
        attempted: 0,
        sent: 0,
        failed: 0,
        skipped: 1,
        windowStartIso: input.windowStartIso,
        windowEndIso: input.windowEndIso,
      });
      continue;
    }

    const rendered = renderDigest(input, base);
    attempted += input.recipients.length;
    let successfulEnvelopeCount = 0;
    for (const recipient of input.recipients) {
      try {
        await sendEmail({
          to: recipient,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        successfulEnvelopeCount += 1;
        sent += 1;
      } catch {
        failed += 1;
      }
    }

    if (successfulEnvelopeCount === input.recipients.length) {
      try {
        await prisma.team.update({
          where: { id: input.teamId },
          data: { lastDailyDigestAt: now },
        });
      } catch {
        // Stamp update failures are best-effort; envelopes are already
        // dispatched. The envelope count is what we promise; the next
        // tick's same-day gate will surface the surfaced-but-unstamped
        // gap only if no recipient enrolled since.
      }
    }
    teamResults.push({
      teamId: input.teamId,
      severityCounts: input.severityCounts,
      attempted: input.recipients.length,
      sent: successfulEnvelopeCount,
      failed: input.recipients.length - successfulEnvelopeCount,
      skipped: 0,
      windowStartIso: input.windowStartIso,
      windowEndIso: input.windowEndIso,
    });
  }
  return { attempted, sent, failed, skipped, teamResults };
}

// Per-team orchestrator used by the manual trigger route. Returns the
// `DailyDigestRunResult` shape directly so the route handler doesn't
// need to glue it together. The `force` flag bypasses the same-day
// stamp so an admin pressing the button is an explicit re-trigger.
export async function runDailyAlertDigestForTeam(
  teamId: string,
  now: Date,
  options: RunDailyDigestForTeamOptions,
): Promise<RunDailyDigestForTeamResult> {
  const all = await findDailyDigestInputs(now);
  const input = all.find((i) => i.teamId === teamId);
  if (!input) {
    return {
      id: null,
      teamId,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
      windowStartIso: new Date(now.getTime() - TWENTY_FOUR_HOURS_MS).toISOString(),
      windowEndIso: now.toISOString(),
    };
  }

  if (!options.force) {
    const teamRow = await prisma.team.findUnique({
      where: { id: teamId },
      select: { lastDailyDigestAt: true },
    });
    if (teamRow && !shouldFireToday(teamRow.lastDailyDigestAt, now)) {
      return {
        id: null,
        teamId,
        severityCounts: input.severityCounts,
        attempted: 0,
        sent: 0,
        failed: 0,
        skipped: 1,
        windowStartIso: input.windowStartIso,
        windowEndIso: input.windowEndIso,
      };
    }
  }

  void fromFor('digest');
  const base = options.appBaseUrl.replace(/\/+$/, '');
  const rendered = renderDigest(input, base);

  let successfulEnvelopeCount = 0;
  let envelopeFailureCount = 0;
  for (const recipient of input.recipients) {
    try {
      await sendEmail({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      successfulEnvelopeCount += 1;
    } catch {
      envelopeFailureCount += 1;
    }
  }

  if (successfulEnvelopeCount === input.recipients.length) {
    try {
      await prisma.team.update({
        where: { id: teamId },
        data: { lastDailyDigestAt: now },
      });
    } catch {
      // Best-effort — same posture as the batch sender.
    }
  }

  return {
    id:
      successfulEnvelopeCount === input.recipients.length && input.recipients.length > 0
        ? `daily-${teamId}-${now.toISOString()}`
        : null,
    teamId,
    severityCounts: input.severityCounts,
    attempted: input.recipients.length,
    sent: successfulEnvelopeCount,
    failed: envelopeFailureCount,
    skipped: 0,
    windowStartIso: input.windowStartIso,
    windowEndIso: input.windowEndIso,
  };
}

// Per-UTC-day idempotency gate. Calendar-day compare, NOT a stricter
// `>timestamp` check, because the brief scopes digest delivery to
// ONCE per UTC day. Borrowed verbatim from
// src/lib/business/alerts-digest.ts:291-298 so both digests share the
// same gate semantics; an alternative implementation is duplicated
// here intentionally so the unit test can pin it without touching the
// 07:00 file.
export function shouldFireToday(lastSentAt: Date | null, now: Date): boolean {
  if (!lastSentAt) return true;
  const sameDay =
    lastSentAt.getUTCFullYear() === now.getUTCFullYear() &&
    lastSentAt.getUTCMonth() === now.getUTCMonth() &&
    lastSentAt.getUTCDate() === now.getUTCDate();
  return !sameDay;
}

// Pure helper — coerces a (potentially partial) severity-bucket map
// into the canonical 4-bucket shape `{critical,high,medium,low}` with
// missing keys defaulting to 0. Exported so tests can pin it without
// going through prisma.
export function groupBySeverity(rows: Array<{ severity: string | null }>): {
  critical: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = (row.severity ?? '').toLowerCase();
    if (key.length === 0) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return {
    critical: counts.critical ?? 0,
    high: counts.high ?? 0,
    medium: counts.medium ?? 0,
    low: counts.low ?? 0,
  };
}

interface RenderedDailyDigest {
  subject: string;
  html: string;
  text?: string;
}

// Render the appropriately-shaped email for a digest input. All-clear
// branch fires when `items.length === 0`. The CTA URL is the
// `/alerts?ownedByMe=1` deep link — the /alerts page reads
// `?ownedByMe=1` and the /api/alerts handler narrows server-side on
// `ownerId: ctx.membership.id`. Per-row anchors use the same deep link
// so a click on any row lands on the filtered page rather than
// bouncing back to the unfiltered queue.
function renderDigest(input: DailyDigestInput, base: string): RenderedDailyDigest {
  const ctaUrl = `${base}/alerts?ownedByMe=1`;
  if (input.items.length === 0) {
    return dailyAlertAllClearEmail({
      teamName: input.teamName,
      winStartIso: input.windowStartIso,
      winEndIso: input.windowEndIso,
    });
  }

  const items = input.items.map((item) => ({
    id: item.id,
    severity: item.severity,
    cveId: item.cveId,
    host: item.host,
    url: ctaUrl,
  }));

  return dailyAlertDigestEmail({
    teamName: input.teamName,
    winStartIso: input.windowStartIso,
    winEndIso: input.windowEndIso,
    severityCounts: input.severityCounts,
    items,
    ctaUrl,
  });
}

export const _constants = {
  TWENTY_FOUR_HOURS_MS,
  SEVERITIES,
};
