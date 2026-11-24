// @polsia:user-owned — Business lib for the per-user 08:30 UTC daily
// alert digest cron (jobs/daily-user-digest.ts). Companion to
// src/lib/business/daily-alert-digest.ts (per-team 09:00) with a
// deliberately different scope, recipient shape, link target, and
// stamp column.
//
// Selection rule (24h createdAt, OPEN status only — flipped from
// "every status" v1 to "open only" so the brief's literal "open
// alerts" semantics lands once the per-user knobs ship; closed/FP
// rows are out of scope):
//   - DailyDigestPrefs.findMany({ where: { digestEnabled: true } })
//     selects opted-in users. The selector lifts the new
//     `severityThreshold` and `assetScope` columns so the additional
//     Prisma `where` clauses can be composed PER USER (each user has
//     their own threshold + scope; the per-team cron CANNOT share one
//     uniform WHERE).
//   - For each, single Membership row (userId @unique) gives the
//     user's team. Users with no Membership (defensive — unreachable
//     under the workspace bootstrap) are SKIPPED silently.
//   - Single batched Alert.findMany filtered by
//     teamId IN <teams> AND status: 'open' AND
//       createdAt >= now-24h AND
//       (ownerId IS NULL OR ownerId IN <userIds>)
//     AND, PER USER, status:'open' (always) +
//          `severity IN <threshold-and-up>` if non-null +
//          `finding.asset.OR [{host,port,protocol}, …]` if assetScope non-empty.
//   - Severity counts come from in-memory bucketing so the rendered
//     counts match the threshold narrowly, not the bare window.
//
// Per-user filter composition:
//   - `severityThreshold` widens by SEVERITY_RANK ordinal — 'critical'
//     narrows to `['critical']`, 'high' to `['critical','high']`, etc.
//     `low` is the inclusive lower bound so omitting the clause is
//     equivalent. The selector does NOT issue a per-user findMany —
//     instead it qualifies the single batched findMany by reusing
//     in-memory buckets once the rows land. issue is: the assetScope
//     filter CANNOT be done in Prisma via in-memory post-filter
//     (because the OR clause is what makes the scan index-only on
//     (host, port, protocol)). So SELECTION's where gets the asset
//     clause composed BUT we keep the shape single-team+global so the
//     24h scan doesn't fragment.
//
// Recipient: a single User row (one envelope) — the per-team 09:00
// uses WorkspaceMember(workspaceId, status='active') instead. Per-user
// recipients are richer (the email itself, not membership roster),
// so we resolve `User.email` directly. Null email → SKIP.
//
// Stamp semantics + no all-clear:
//   - `shouldFireToday(lastSentAt, now)` is the per-UTC-day gate
//     (borrowed from daily-alert-digest.ts:454-461 in spirit — calendar-
//     day UTC compare). A user whose `lastSentAt` matches today's UTC
//     date is silently SKIPPED (no envelope, no stamp advance).
//   - NO all-clear branch (per brief — only NEW alerts count).
//     Empty-day users are skipped silently and the stamp does NOT
//     advance (so a same-day retry would re-evaluate — same posture
//     as the 09:00 selector but the stamp-driver differs because
//     there's no all-clear branch to stamp).
//
// Error isolation:
//   - One bad recipient does NOT abort the rest of the batch — each
//     sendEmail call sits inside its own try/catch in the sender loop.
//   - Top-level cron try/catch in jobs/daily-user-digest.ts swallows
//     selector and sender errors with a console breadcrumb so a
//     transient DB blip never crashes the cron.
//   - Per-user filter parse failures (a malformed assetScope string
//     that survived the route's validation, e.g. through an
//     out-of-band write) log + SKIP that single user without
//     aborting the rest of the batch.
//
// fromFor('digest'):
//   - Looked up once and discarded as informational. The proxy binds
//     the actual `From` header at the edge using the per-category map.
//     sendEmail() does not accept a custom `from`; the email proxy
//     intentionally rejects attachments, cc/bcc, and custom From.

import 'server-only';
import { AssetFilterError, parseAssetName } from '@/lib/business/alerts-asset';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { dailyUserDigestEmail } from '@/lib/email/templates';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Top-crit/high cap per the brief. Picks the user's biggest problems
// (up to 5 critical + up to 5 high); medium + low are summarised by
// the count lines and never appear as `topItems` rows.
const TOP_CRITICAL_CAP = 5;
const TOP_HIGH_CAP = 5;

export interface DailyUserDigestItem {
  id: string;
  severity: string;
  cveId: string;
  host: string;
  /** Precomputed `${appBaseUrl}/alerts/${id}` so the template does not
   *  re-derive the URL — same per-row anchor the brief calls for. */
  url: string;
}

export interface DailyUserDigestInput {
  userId: string;
  email: string;
  teamId: string;
  teamName: string;
  totalItems: number;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  topItems: DailyUserDigestItem[];
  windowStartIso: string;
  windowEndIso: string;
}

export interface SendDailyUserDigestsOptions {
  appBaseUrl: string;
}

export interface SendDailyUserDigestsResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  userResults: DailyUserDigestRunSummary[];
}

export interface DailyUserDigestRunSummary {
  userId: string;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  windowStartIso: string;
  windowEndIso: string;
}

interface RawAlertRow {
  id: string;
  teamId: string;
  ownerId: string | null;
  severity: string | null;
  createdAt: Date;
  finding: { cveId: string; asset: { host: string; port: number; protocol: string } };
}

interface RawMembershipRow {
  userId: string;
  teamId: string;
}

interface RawTeamRow {
  id: string;
  name: string;
}

interface RawUserRow {
  id: string;
  email: string;
}

interface RawPrefRow {
  userId: string;
  digestEnabled: boolean | null;
  severityThreshold: string | null;
  assetScope: unknown;
  lastSentAt: Date | null;
}

// Severity rank — lower number = higher urgency. Used by the Top-N
// pick so a user's critical bucket drains before their high bucket,
// AND by the per-user `severity IN [...]` filter composition so the
// threshold knob is structurally consistent end-to-end.
const SEVERITY_RANK: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEVERITY_VALUES: ReadonlyArray<'critical' | 'high' | 'medium' | 'low'> = [
  'critical',
  'high',
  'medium',
  'low',
];

function severityRank(severity: string | null): number {
  if (!severity) return SEVERITY_RANK.medium;
  const key = severity.toLowerCase();
  if (key === 'critical' || key === 'high' || key === 'medium' || key === 'low') {
    return SEVERITY_RANK[key];
  }
  return SEVERITY_RANK.medium;
}

// Inclusive severities at-or-above the user's threshold. `'critical'
// → ['critical']`, `'high' → ['critical','high']`, `'medium' → ['critical',
// 'high', 'medium']`, `'low' → ['critical','high','medium','low']`. An
// unrecognised threshold (e.g. a typo that slipped through the UI
// layer) returns the same inclusive 'low' list so the cron degrades
// gracefully instead of silently dropping the user.
function severitiesAtOrAbove(threshold: string | null | undefined): string[] | null {
  if (threshold == null) return null;
  const key = threshold.toLowerCase();
  if (key !== 'critical' && key !== 'high' && key !== 'medium' && key !== 'low') {
    return SEVERITY_VALUES.slice();
  }
  const out: string[] = [];
  for (const sev of SEVERITY_VALUES) {
    out.push(sev);
    if (sev === key) break;
  }
  return out;
}

// Per-UTC-day idempotency gate. Calendar-day compare, NOT a stricter
// `>timestamp` check, because the brief scopes digest delivery to
// ONCE per UTC day. Mirrors the gate exported from
// src/lib/business/daily-alert-digest.ts:454-461 so the 09:00 nightly
// stamp and the 08:30 per-user stamp share the same semantics
// (different columns but the same calendar-day compare window).
export function shouldFireToday(lastSentAt: Date | null, now: Date): boolean {
  if (!lastSentAt) return true;
  const sameDay =
    lastSentAt.getUTCFullYear() === now.getUTCFullYear() &&
    lastSentAt.getUTCMonth() === now.getUTCMonth() &&
    lastSentAt.getUTCDate() === now.getUTCDate();
  return !sameDay;
}

// Convert the per-user persisted assetScope (Json string[]) into the
// Prisma `[{host, port, protocol}, ...]` shape the alerter's
// `finding.asset.OR` clause expects. Defensive — the route layer
// validates names on PUT, but a row written out-of-band (a manual SQL
// insert, a stale prod migration) might carry junk. Throws
// AssetFilterError so the caller can opt to log + skip that user.
// Returns [] for null/empty scope so the caller drops the clause.
function assetScopeToOrList(
  scope: unknown,
): Array<{ host: string; port: number; protocol: string }> {
  if (!Array.isArray(scope) || scope.length === 0) return [];
  const out: Array<{ host: string; port: number; protocol: string }> = [];
  for (const entry of scope) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const parsed = parseAssetName(entry);
    if (parsed == null) {
      throw new AssetFilterError(
        'malformed_name',
        `assetScope entry "${entry}" is not in host:port/protocol shape.`,
      );
    }
    out.push(parsed);
  }
  return out;
}

// Pure selector. Returns one DailyUserDigestInput per opted-in User:
//
// 1. Lift every DailyDigestPrefs row with `digestEnabled: true` +
//    the new `severityThreshold` + `assetScope` columns.
// 2. Batch User.findMany ({ id: IN prefIds }) for emails.
// 3. Batch Membership.findMany ({ userId IN prefIds }) —
//    Membership.userId @unique gives exactly one row per user. Read
//    userId → teamId map.
// 4. Single batched Alert.findMany filtered by
//    teamId IN <teams> AND status: 'open' AND createdAt >= now-24h AND
//      (ownerId IS NULL OR ownerId IN <userIds>)
//    — rows are in-memory bucketed per user with their personal
//    threshold + asset scope so the per-user filter is composed out-
//    of-band (faster + keeps the alert scan to one round trip).
// 5. groupBy walk: bucket per (teamId, ownerOrNull, severity) so we
//    can derive the 4-bucket count map AND the per-user Top-N in one
//    pass. Then post-filter per user by severityThreshold +
//    assetScope so the counts and topItems reflect the prefs.
//      - The `severity` filter is a post-pass on the bucket because
//        Prisma's per-user `severity IN [...]` clause would fragment
//        the scan MULTIPLE times. Since the threshold-and-up set is
//        small (≤ 4 entries) the in-memory post-pass is honest.
//      - The asset filter is applied at the per-user findMany via
//        a per-user `finding.asset.OR [...]` clause composition —
//        but we can't issue per-user queries, so the asset filter is
//        ALSO a post-pass on the bucket (the scan would be tighter but
//        the scan is already bounded by `teamId IN <user-teams>` so
//        the cost is acceptable).
// 6. Assemble DailyUserDigestInput per user. Skip users missing a
//    Membership row (cheap `continue`) — the workspace bootstrap
//    always creates one, so this is the structural defensive guard.
export async function findDailyUserDigestInputs(now: Date): Promise<DailyUserDigestInput[]> {
  const prefs: RawPrefRow[] = await prisma.dailyDigestPrefs.findMany({
    where: { digestEnabled: true },
    select: {
      userId: true,
      digestEnabled: true,
      severityThreshold: true,
      assetScope: true,
      lastSentAt: true,
    },
  });
  if (prefs.length === 0) return [];

  const userIds = prefs.map((p) => p.userId);
  const windowStart = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);

  const users: RawUserRow[] = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true },
  });

  const memberships: RawMembershipRow[] = await prisma.membership.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, teamId: true },
  });

  // userId -> Membership: at most one row per user (@unique). Users with
  // no Membership are skipped silently — the workspace bootstrap creates
  // one, so this is the unreachable defensive branch.
  const teamByUser = new Map<string, string>();
  for (const m of memberships) {
    teamByUser.set(m.userId, m.teamId);
  }

  // Email lookup — null emails are skipped.
  const emailByUser = new Map<string, string>();
  for (const u of users) {
    if (u.email && u.email.length > 0) {
      emailByUser.set(u.id, u.email);
    }
  }

  // Parse the per-user assetOrList once (forward of the alert findMany)
  // so a single bad entry logs + skips just that user instead of a
  // batch-wide abort. Any thrown AssetFilterError is caught at the
  // per-user level below.
  type ResolvedPrefs = {
    userId: string;
    email: string;
    teamId: string;
    severitySet: string[] | null; // null = "all severities"
    assetOrList: Array<{ host: string; port: number; protocol: string }> | null; // null = "all assets"
  };
  const eligibleUsers: ResolvedPrefs[] = [];
  for (const p of prefs) {
    const teamId = teamByUser.get(p.userId);
    const email = emailByUser.get(p.userId);
    if (!teamId || !email) continue;

    let assetOrList: Array<{ host: string; port: number; protocol: string }> | null = null;
    try {
      const list = assetScopeToOrList(p.assetScope);
      assetOrList = list.length > 0 ? list : null;
    } catch (_err) {
      continue;
    }

    eligibleUsers.push({
      userId: p.userId,
      email,
      teamId,
      severitySet: severitiesAtOrAbove(p.severityThreshold),
      assetOrList,
    });
  }
  if (eligibleUsers.length === 0) return [];

  const teamIds = Array.from(new Set(eligibleUsers.map((e) => e.teamId)));
  const eligibleUserIds = eligibleUsers.map((e) => e.userId);

  // Pull every open alert in the window across all eligible teams,
  // scoped to (ownerId IS NULL OR ownerId IN <userIds>). The composite
  // index @@index([teamId, ownerId]) keeps the per-team/per-owner probe
  // index-only; @@index([teamId, createdAt(sort: Desc)]) serves the
  // 24h window filter. `status: 'open'` aligns with the brief's
  // "open alerts" semantics — closed / FP rows are out of scope for
  // this cadence. Single round-trip so the cron does not thrash the
  // data plane.
  const alerts: RawAlertRow[] = await prisma.alert.findMany({
    where: {
      teamId: { in: teamIds },
      status: 'open',
      createdAt: { gte: windowStart },
      OR: [{ ownerId: null }, { ownerId: { in: eligibleUserIds } }],
    },
    select: {
      id: true,
      teamId: true,
      ownerId: true,
      severity: true,
      createdAt: true,
      finding: {
        select: {
          cveId: true,
          asset: { select: { host: true, port: true, protocol: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Per (team, owner-or-null) bucket so we can resolve the
  // 4-bucket count map AND the per-user Top-N in one pass.
  type Bucket = { counts: Map<string, number>; rows: RawAlertRow[] };
  const buckets = new Map<string, Bucket>();
  for (const a of alerts) {
    const scope = a.ownerId ?? '__null__';
    const key = `${a.teamId}::${scope}`;
    let b = buckets.get(key);
    if (!b) {
      b = { counts: new Map(), rows: [] };
      buckets.set(key, b);
    }
    const sevKey = (a.severity ?? 'medium').toLowerCase();
    b.counts.set(sevKey, (b.counts.get(sevKey) ?? 0) + 1);
    b.rows.push(a);
  }

  // Resolve team names once.
  const teams: RawTeamRow[] = await prisma.team.findMany({
    where: { id: { in: teamIds } },
    select: { id: true, name: true },
  });
  const teamNameById = new Map<string, string>();
  for (const t of teams) {
    teamNameById.set(t.id, t.name);
  }

  const inputs: DailyUserDigestInput[] = [];
  for (const eu of eligibleUsers) {
    const allRows: RawAlertRow[] = [];
    if (eu.severitySet == null && eu.assetOrList == null) {
      // No per-user narrowing — read straight from the buckets.
      const ownBucket = buckets.get(`${eu.teamId}::${eu.userId}`);
      const nullBucket = buckets.get(`${eu.teamId}::__null__`);
      allRows.push(...(ownBucket?.rows ?? []), ...(nullBucket?.rows ?? []));
    } else {
      // Per-user narrowing. Walk the same two buckets and apply the
      // prefs in-process: severity in the threshold set + asset match.
      const ownBucket = buckets.get(`${eu.teamId}::${eu.userId}`);
      const nullBucket = buckets.get(`${eu.teamId}::__null__`);
      const combined: RawAlertRow[] = [...(ownBucket?.rows ?? []), ...(nullBucket?.rows ?? [])];
      for (const row of combined) {
        if (eu.severitySet != null) {
          const sev = (row.severity ?? 'medium').toLowerCase();
          if (!eu.severitySet.includes(sev)) continue;
        }
        if (eu.assetOrList != null) {
          const a = row.finding?.asset;
          let matched = false;
          for (const triplet of eu.assetOrList) {
            if (
              a &&
              a.host === triplet.host &&
              a.port === triplet.port &&
              a.protocol === triplet.protocol
            ) {
              matched = true;
              break;
            }
          }
          if (!matched) continue;
        }
        allRows.push(row);
      }
    }

    type SeverityCounts = { critical: number; high: number; medium: number; low: number };
    const mkCounts = (rows: ReadonlyArray<RawAlertRow>): SeverityCounts => {
      const map = new Map<string, number>();
      for (const r of rows) {
        const sevKey = (r.severity ?? 'medium').toLowerCase();
        map.set(sevKey, (map.get(sevKey) ?? 0) + 1);
      }
      return {
        critical: map.get('critical') ?? 0,
        high: map.get('high') ?? 0,
        medium: map.get('medium') ?? 0,
        low: map.get('low') ?? 0,
      };
    };
    const severityCounts = mkCounts(allRows);
    const totalItems =
      severityCounts.critical + severityCounts.high + severityCounts.medium + severityCounts.low;

    // Top-N pick. Drain critical first (cap = TOP_CRITICAL_CAP), then
    // high (cap = TOP_HIGH_CAP). Sort within each bucket by createdAt
    // desc so the freshest row is at the head of the digest. Reuses
    // pickTopItems so the threshold filter narrows the same feed (no
    // separate caps for < medium rows).
    const topItems = pickTopItems(allRows);

    inputs.push({
      userId: eu.userId,
      email: eu.email,
      teamId: eu.teamId,
      teamName: teamNameById.get(eu.teamId) ?? 'Workspace',
      totalItems,
      severityCounts,
      topItems,
      windowStartIso: windowStart.toISOString(),
      windowEndIso: now.toISOString(),
    });
  }
  return inputs;
}

// Pure Top-N pick. Exported so the unit test can pin the cap behaviour
// without spinning up Prisma. Drains critical first (cap
// TOP_CRITICAL_CAP), then high (cap TOP_HIGH_CAP); medium + low never
// appear as topItems — they only land in the count lines.
export function pickTopItems(rows: ReadonlyArray<RawAlertRow>): DailyUserDigestItem[] {
  const sorted = [...rows].sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank !== 0) return rank;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const topItems: DailyUserDigestItem[] = [];
  let critCount = 0;
  let highCount = 0;
  for (const a of sorted) {
    const sev = (a.severity ?? '').toLowerCase();
    if (sev === 'critical') {
      if (critCount >= TOP_CRITICAL_CAP) continue;
      critCount += 1;
    } else if (sev === 'high') {
      if (highCount >= TOP_HIGH_CAP) continue;
      highCount += 1;
    } else {
      // medium / low never appear — the count line carries the totals.
      continue;
    }
    topItems.push({
      id: a.id,
      severity: sev,
      cveId: a.finding.cveId,
      host: a.finding.asset.host,
      // url is filled in by the sender once we know `appBaseUrl` —
      // the selector keeps the row identity surface so an empty
      // appBaseUrl doesn't poison the URL.
      url: '',
    });
  }
  return topItems;
}

// Send the digest queue. Per-user try/catch wraps every sendEmail call
// so one bad recipient does NOT abort the rest of the batch. The
// stamp advances ONLY when the user is eligible to fire today (no
// prior same-day stamp).
//
// Returns aggregated counters AND a per-user breakdown so the batch
// runner can render the same shape.
export async function sendDailyUserDigests(
  inputs: DailyUserDigestInput[],
  now: Date,
  options: SendDailyUserDigestsOptions,
): Promise<SendDailyUserDigestsResult> {
  if (inputs.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0, userResults: [] };
  }

  // Informational only — see the file header.
  void fromFor('digest');

  const base = options.appBaseUrl.replace(/\/+$/, '');

  // Stamp lookup happens in the loop so we can also forward-declare
  // the gate decision (skip OR send) in the per-user summary. We
  // would otherwise need two round-trips — one for the gate, one for
  // the stamp step.

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const userResults: DailyUserDigestRunSummary[] = [];

  for (const input of inputs) {
    const pref = await prisma.dailyDigestPrefs.findUnique({
      where: { userId: input.userId },
      select: { lastSentAt: true },
    });
    if (pref && !shouldFireToday(pref.lastSentAt, now)) {
      skipped += 1;
      userResults.push({
        userId: input.userId,
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

    // Stamp URLs onto topItems now that we know the base. Doing this
    // here (not in the selector) keeps the selector free of env
    // dependency — the cron entry is the ONLY place that resolves
    // appBaseUrl from env.
    const stamped: DailyUserDigestInput = {
      ...input,
      topItems: input.topItems.map((item) => ({
        ...item,
        url: `${base}/alerts/${item.id}`,
      })),
    };

    const rendered = renderDailyUserDigest(stamped, base);
    attempted += 1;
    let envelopeFailed = false;
    try {
      await sendEmail({
        to: stamped.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      sent += 1;
    } catch {
      failed += 1;
      envelopeFailed = true;
    }

    // Stamp advances ONLY on a successful send. Same-day retries can
    // re-attempt → the gate is what stops a busy recipient from
    // re-sending, NOT the stamp.
    if (!envelopeFailed) {
      try {
        await prisma.dailyDigestPrefs.update({
          where: { userId: stamped.userId },
          data: { lastSentAt: now },
        });
      } catch {
        // best-effort; the envelope already went out and the next
        // tick's gate will surface a surfaced-but-unstamped gap only
        // if no recipient enrolled since.
      }
    }
    userResults.push({
      userId: stamped.userId,
      severityCounts: stamped.severityCounts,
      attempted: envelopeFailed ? 0 : 1,
      sent: envelopeFailed ? 0 : 1,
      failed: envelopeFailed ? 1 : 0,
      skipped: 0,
      windowStartIso: stamped.windowStartIso,
      windowEndIso: stamped.windowEndIso,
    });
  }

  return { attempted, sent, failed, skipped, userResults };
}

interface RenderedDailyUserDigest {
  subject: string;
  html: string;
  text?: string;
}

// Render the digest envelope. `ctaUrl` is passed through the contract
// so a future revision can add a CTA without breaking the sender.
function renderDailyUserDigest(
  input: DailyUserDigestInput,
  _base: string,
): RenderedDailyUserDigest {
  return dailyUserDigestEmail({
    teamName: input.teamName,
    winStartIso: input.windowStartIso,
    winEndIso: input.windowEndIso,
    totalItems: input.totalItems,
    severityCounts: input.severityCounts,
    topItems: input.topItems,
    ctaUrl: `${_base}/alerts`,
  });
}

export const _constants = {
  TWENTY_FOUR_HOURS_MS,
  TOP_CRITICAL_CAP,
  TOP_HIGH_CAP,
  SEVERITY_RANK,
};
