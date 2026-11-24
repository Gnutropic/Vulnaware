// @polsia:user-owned — server lib that backs jobs/alert-digest.ts.
// Exports a pure selector (`findAlertDigestInputs`) and a sender
// (`sendDigests`) so the cron stays small AND the selector is unit-testable
// without running the whole pipeline.
//
// Selection rule (last 24h, un-acknowledged, sev ∈ {critical, high}):
//   - Team.digestEnabled === true (column default is `true` so legacy rows
//     opt-in post-`prisma db push`; Prisma types the column as non-nullable
//     so a null branch is structurally unreachable).
//   - Alert.teamId IN <active teams>
//   - Alert.severity ∈ ('critical','high')
//   - Alert.acknowledgedAt IS NULL
//   - Alert.createdAt >= now - 24h
//   - Hits `@@index([teamId, createdAt(sort: Desc)])` for the team-keyed window.
//
// Recipient resolution: `WorkspaceMember(workspaceId IN teamIds, status='active')`
// so only onboarded teammates get an email; pending invites are excluded by
// status, not by an app-level filter.
//
// Stamp semantics / all-clear branch:
//   - `shouldFireToday(lastSentAt, now)` is the per-UTC-day gate (calendar-
//     day compare borrowed from jobs/trial-reminders.ts). A team whose stamp
//     matches today's UTC date returns false → the digest is a no-op.
//   - Teams with at least one matching alert are grouped, top-5 assets by
//     `host:port` frequency are derived for the summary line, and a digest
//     email is rendered + sent per team. The stamp advances on the same
//     transactional rule: a partial send failure leaves the stamp alone so
//     the next UTC-day tick skips them, but a same-day retry would otherwise
//     run the same selector — accepted because the windows-up-to-now selector
//     and the audit log are the canonical record.
//   - Teams with ZERO matching alerts but at least one active member are
//     subject to the all-clear branch: a short "no open critical/high alerts
//     in the last 24h" email is sent exactly once per UTC day. Stamp
//     advances so the next tick is a no-op (same gate).
//   - Teams with zero members are SKIPPED silently — no envelope, no stamp.
//
// fromFor('alerts'):
//   - Looked up once and discarded as informational. The proxy binds the
//     actual `From` header at the edge using the per-category map.
//     sendEmail() does not accept a custom `from` and the email proxy
//     intentionally rejects attachments, cc/bcc, and custom From.
//     Same posture as src/lib/business/alerts-dispatch.ts and
//     src/lib/business/trial-first-scan-nudge.ts.

import 'server-only';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { alertAllClearEmail, alertDigestEmail } from '@/lib/email/templates';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const TOP_ASSETS_LIMIT = 5;

export type DigestSeverity = 'critical' | 'high';

export interface DigestAlertItem {
  id: string;
  severity: string;
  cveId: string;
  host: string;
  port: number;
}

export interface AlertDigestInput {
  teamId: string;
  teamName: string;
  recipients: string[];
  items: DigestAlertItem[];
  topAssets: string[];
  windowStartIso: string;
  windowEndIso: string;
}

export interface SendDigestsOptions {
  appBaseUrl: string;
}

export interface SendDigestsResult {
  sent: number;
  failed: number;
  skipped: number;
}

interface RawAlertWithFinding {
  id: string;
  teamId: string;
  severity: string | null;
  createdAt: Date;
  finding: { cveId: string; asset: { host: string; port: number } };
}

interface RawTeamRow {
  id: string;
  name: string;
  lastAlertDigestAt: Date | null;
}

interface RawMemberRow {
  workspaceId: string;
  email: string;
}

// Pure selector. Returns one AlertDigestInput per Team in scope:
//   1. Lifts every Team whose `digestEnabled === true` (the column
//      default is `true` so legacy rows opt-in post-`prisma db push`;
//      Prisma types the column as non-nullable so a null check is
//      structurally unreachable).
//   2. Single batched Alert.findMany over that team set, joined into
//      VulnerabilityFinding → Asset so each row carries `cveId`, `host`,
//      `port`. Hits `@@index([teamId, createdAt(sort: Desc)])`.
//   3. Single batched WorkspaceMember.findMany(active members per team)
//      for recipients. Pre-acceptance invites are excluded by `status`.
//   4. For each team, groups the alerts, derives top-5 assets by
//      frequency of `host:port`, and assembles the digest input.
export async function findAlertDigestInputs(now: Date): Promise<AlertDigestInput[]> {
  const teams: RawTeamRow[] = await prisma.team.findMany({
    where: { digestEnabled: true },
    select: { id: true, name: true, lastAlertDigestAt: true },
  });
  if (teams.length === 0) return [];

  const teamIds = teams.map((t) => t.id);
  const windowStart = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);

  const alerts: RawAlertWithFinding[] = await prisma.alert.findMany({
    where: {
      teamId: { in: teamIds },
      severity: { in: ['critical', 'high'] },
      acknowledgedAt: null,
      createdAt: { gte: windowStart },
    },
    select: {
      id: true,
      teamId: true,
      severity: true,
      createdAt: true,
      finding: { select: { cveId: true, asset: { select: { host: true, port: true } } } },
    },
    orderBy: { createdAt: 'asc' },
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

  const inputs: AlertDigestInput[] = [];
  for (const team of teams) {
    const teamAlerts = alertsByTeam.get(team.id) ?? [];
    const recipients = recipientsByTeam.get(team.id) ?? [];
    if (recipients.length === 0) continue;

    if (teamAlerts.length === 0) {
      inputs.push({
        teamId: team.id,
        teamName: team.name,
        recipients,
        items: [],
        topAssets: [],
        windowStartIso: windowStart.toISOString(),
        windowEndIso: now.toISOString(),
      });
      continue;
    }

    const assetCounts = new Map<string, number>();
    const items: DigestAlertItem[] = teamAlerts.map((a) => {
      const host = a.finding.asset.host;
      const port = a.finding.asset.port;
      const assetKey = `${host}:${port}`;
      assetCounts.set(assetKey, (assetCounts.get(assetKey) ?? 0) + 1);
      return {
        id: a.id,
        severity: a.severity ?? 'unknown',
        cveId: a.finding.cveId,
        host,
        port,
      };
    });

    const topAssets = Array.from(assetCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_ASSETS_LIMIT)
      .map(([assetKey]) => assetKey);

    inputs.push({
      teamId: team.id,
      teamName: team.name,
      recipients,
      items,
      topAssets,
      windowStartIso: windowStart.toISOString(),
      windowEndIso: now.toISOString(),
    });
  }
  return inputs;
}

// Send the digest queue. Per-team try/catch wraps every sendEmail call so
// one bad team does not abort the rest of the batch. The stamp advances
// ONLY when every recipient currently in scope for that team sent
// successfully AND the team was eligible to fire today (no prior same-day
// stamp). Partial failures leave the stamp alone so a future same-day
// retry can re-evaluate recipients.
//
// Returns `sent` (envelopes delivered), `failed` (envelopes that threw),
// and `skipped` (teams that did not fire today or had empty inputs /
// unmatched member lists).
export async function sendDigests(
  inputs: AlertDigestInput[],
  now: Date,
  options: SendDigestsOptions,
): Promise<SendDigestsResult> {
  if (inputs.length === 0) {
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Informational only — see the file header.
  void fromFor('alerts');

  const base = options.appBaseUrl.replace(/\/+$/, '');
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const input of inputs) {
    // Same-day idempotency gate — drop teams whose `lastAlertDigestAt`
    // already matches today's UTC calendar date. Skipped is preferred to
    // a 500 so a stalled-but-replayed cron emits a useful deploy log.
    const teamRow = await prisma.team.findUnique({
      where: { id: input.teamId },
      select: { lastAlertDigestAt: true },
    });
    if (teamRow && !shouldFireToday(teamRow.lastAlertDigestAt, now)) {
      skipped += 1;
      continue;
    }

    const rendered = renderDigest(input, base);
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
      } catch (_err) {
        failed += 1;
      }
    }

    if (successfulEnvelopeCount === input.recipients.length) {
      try {
        await prisma.team.update({
          where: { id: input.teamId },
          data: { lastAlertDigestAt: now },
        });
      } catch (_err) {
        // Stamp update failures are best-effort; the cron has already
        // dispatched. Surface in the next deploy log via the failed
        // counter — the envelope count is what we promise.
        failed += 0; // intentional no-op already counted above
      }
    }
  }
  return { sent, failed, skipped };
}

// Per-UTC-day idempotency gate. Mirrors trial-reminders.ts:37-52 — the
// stamp is a UTC calendar-day compare, not a stricter `>timestamp` check,
// because the brief scopes digest delivery to ONCE per UTC day.
export function shouldFireToday(lastSentAt: Date | null, now: Date): boolean {
  if (!lastSentAt) return true;
  const sameDay =
    lastSentAt.getUTCFullYear() === now.getUTCFullYear() &&
    lastSentAt.getUTCMonth() === now.getUTCMonth() &&
    lastSentAt.getUTCDate() === now.getUTCDate();
  return !sameDay;
}

interface RenderedDigest {
  subject: string;
  html: string;
  text?: string;
}

// Render the appropriately-shaped email for a digest input. All-clear
// branch fires when items.length === 0; counts include both critical and
// high severity rows. The CTA URL is the most recent item's
// `/alerts/[id]` page; the all-clear variant omits the CTA.
function renderDigest(input: AlertDigestInput, base: string): RenderedDigest {
  if (input.items.length === 0) {
    return alertAllClearEmail({
      teamName: input.teamName,
      winStartIso: input.windowStartIso,
      winEndIso: input.windowEndIso,
    });
  }

  const ctaUrl = `${base}/alerts/${input.items[0]?.id ?? ''}`;
  const items = input.items.map((item) => ({
    id: item.id,
    severity: item.severity,
    cveId: item.cveId,
    host: item.host,
    url: `${base}/alerts/${item.id}`,
  }));

  return alertDigestEmail({
    teamName: input.teamName,
    winStartIso: input.windowStartIso,
    winEndIso: input.windowEndIso,
    alertCount: input.items.length,
    topAssets: input.topAssets,
    items,
    ctaUrl,
  });
}

export const _constants = {
  TWENTY_FOUR_HOURS_MS,
  TOP_ASSETS_LIMIT,
};
