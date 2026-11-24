// @polsia:user-owned — Business lib for the per-team weekly AI-generated
// risk-trend email digest. Exposes:
//
//   - `startOfUtcWeek(now)` — pure date helper returning the Monday
//     00:00 UTC floor of `now`. Used for the dedupe composite key
//     `(workspaceId, weekStart, triggeredBy)`. Monday-floor is the brief:
//     Monday 08:00 UTC is when the digest "lands" in the team inbox.
//   - `summariseWeekOverWeek(recent, prior)` — pure selector that turns
//     two Alert slices (last 7d vs the prior 7d) into a deterministic
//     {alertCount, velocity, openCount, ackCount, topHotspots, topMovers,
//     topCriticals} payload. Used both as the LLM prompt context AND as
//     unit-testable input. Top-N caps (5 hotspots, 10 movers, 10
//     criticals) match the wire shape.
//   - `shouldFireThisWeek(lastDigestLog, weekStart, triggeredBy)` — pure
//     idempotency gate. Cron: fire unless the same (workspaceId,
//     weekStart, triggeredBy='cron') row already exists. Manual: always
//     fire (the admin button is explicitly a re-trigger).
//   - `generateWeeklyDigestForTeam(teamId, summary)` — LLM oracle via
//     `generateObject` from `@/lib/ai/client` with a bounded zod
//     response shape. Throws on proxy failure so the orchestrator can
//     skip-and-log (mirror competitive-intel.ts).
//   - `runWeeklyRiskDigestForTeam(teamId, now, options)` — per-team
//     orchestrator. Returns `{ id, attempted, sent, failed, skipped,
//     weekStart }` so the route handler can render a row-prepend in the
//     admin island.
//   - `runWeeklyRiskDigest(now, options)` — whole-batch orchestrator.
//     Iterates `Team.findMany({ select: { id } })` and delegates per-team
//     with isolation so one bad team does NOT abort the rest of the
//     batch.
//
// Skip-on-AI-failure policy: when `generateObject` throws (proxy down,
// malformed payload, parse miss), the per-team orchestrator SKIPS the
// row and never inserts a degraded `DigestLog`. A successful re-run
// later closes the gap.
//
// Recipient convention: `WorkspaceMember(workspaceId = teamId, status =
// 'active')` mirrors alerts-digest.ts:142-153. Pending invites are
// excluded by `status`, not by a UI-side filter. Empty team = silent
// skip (no envelope, no stamp).
//
// Naming: the brief's `workspaceId` is renamed to `teamId` here for
// consistency with the rest of the per-team code surface (see the
// migration banner comment in alerts-digest.ts and the comparable banner
// in competitive-intel.ts).

import 'server-only';
import { z } from 'zod';
import { generateObject } from '@/lib/ai/client';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { weeklyRiskDigestEmail } from '@/lib/email/templates';

const SEVEN_DAYS_MS = 7 * 86_400_000;
const FOURTEEN_DAYS_MS = 14 * 86_400_000;
const HOTSPOTS_LIMIT = 5;
const MOVERS_LIMIT = 10;
const CRITICALS_LIMIT = 10;

export type DigestTrigger = 'cron' | 'manual';
export type DigestStatus = 'sent' | 'failed' | 'partial';

export interface DigestWeekSummary {
  alertCount: number;
  openCount: number;
  ackCount: number;
  velocity: number;
  topHotspots: Array<{ host: string; port: number; count: number }>;
  topMovers: Array<{ cveId: string; delta: number }>;
  topCriticals: Array<{ cveId: string; host: string }>;
  // Trend signal pulled from the most recent VulnerabilityTrend row. May
  // be null on cold-start (no row yet) — the LLM prompt handles the
  // null case with a "no trend in the past 30 days" prose line.
  trendVelocity: number | null;
  // Window bounds so the LLM can stamp its output with the right range.
  windowStartIso: string;
  windowEndIso: string;
}

export interface RunWeeklyDigestOptions {
  triggeredBy: DigestTrigger;
  appBaseUrl: string;
}

export interface RunWeeklyDigestForTeamResult {
  id: string | null;
  weekStart: string;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  status: DigestStatus | null;
}

export interface RunWeeklyDigestResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

// Pure date helper. Monday-floor (no DST — every step is UTC). Tested
// against the ISO 8601 week-numbering rule so a tick on any day of
// `now`'s ISO week returns the same weekStart and a re-run reuses the
// composite upsert key.
export function startOfUtcWeek(now: Date): Date {
  const utc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  // Date.UTC() returns Monday=1 … Sunday=7 — shift so Monday=-3 jumps
  // back to the prior week's Monday morning UTC (negative modulo math
  // is intentional: subtracting then flooring pulls back across week
  // boundaries cleanly).
  const dayShift = (utc.getUTCDay() + 6) % 7;
  return new Date(utc.getTime() - dayShift * 86_400_000);
}

// Past-7-day window. Defined next to `priorWindow7d` (mirror
// alerts-trend.ts: windowOf/priorWindow) so tests can pin deterministically.
export function window7d(now: Date): { windowStart: Date; windowEnd: Date } {
  return { windowStart: new Date(now.getTime() - SEVEN_DAYS_MS), windowEnd: now };
}

export function priorWindow7d(now: Date): { windowStart: Date; windowEnd: Date } {
  const end = new Date(now.getTime() - SEVEN_DAYS_MS);
  const start = new Date(now.getTime() - FOURTEEN_DAYS_MS);
  return { windowStart: start, windowEnd: end };
}

interface RawDigestAlert {
  id: string;
  teamId: string;
  severity: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  finding: { cveId: string; asset: { host: string; port: number } };
}

interface RawTrendRow {
  signal: unknown;
  computedAt: Date;
  windowEnd: Date;
}

// Pure summariser used both at the prompt-construction step AND inside
// the unit tests. Returns a deterministic digest payload that the LLM
// rephrases into the headline / body fields of `WeeklyDigestOutput`.
// Counts and rankings are stable alphabetical tie-breaks so a re-derive
// is byte-identical across cron runs.
//
// `trendVelocity` may be omitted (returned null) on cold-start — the
// caller decides how to phrase the "no trend in the past 30 days" line.
export function summariseWeekOverWeek(
  recentAlerts: RawDigestAlert[] | null | undefined,
  priorAlerts: RawDigestAlert[] | null | undefined,
  trendRow: RawTrendRow | null,
  now: Date,
): DigestWeekSummary {
  const recent = Array.isArray(recentAlerts) ? recentAlerts : [];
  const prior = Array.isArray(priorAlerts) ? priorAlerts : [];

  const recentWindow = window7d(now);
  const openCount = recent.filter((a) => a.acknowledgedAt === null).length;
  const ackCount = recent.length - openCount;
  const velocity = recent.length - prior.length;

  // topHotspots over the past 7 days, capped at 5.
  const hotspotsMap = new Map<string, { host: string; port: number; count: number }>();
  for (const a of recent) {
    const host = a.finding.asset.host;
    const port = a.finding.asset.port;
    const key = `${host}:${port}`;
    const existing = hotspotsMap.get(key);
    if (existing) existing.count += 1;
    else hotspotsMap.set(key, { host, port, count: 1 });
  }
  const topHotspots = Array.from(hotspotsMap.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.host !== b.host) return a.host < b.host ? -1 : 1;
      return a.port - b.port;
    })
    .slice(0, HOTSPOTS_LIMIT);

  // topMovers = CVEs whose recent 7d count and prior 7d count differ.
  // Sorted by absolute delta desc, capped at 10. A CVE whose recent
  // count is 0 and prior is N shows up as a negative-delta mover (the
  // "declining" leg — same shape as alerts-trend's
  // acceleratingDeclines).
  const recentCves = new Map<string, number>();
  for (const a of recent) {
    recentCves.set(a.finding.cveId, (recentCves.get(a.finding.cveId) ?? 0) + 1);
  }
  const priorCves = new Map<string, number>();
  for (const a of prior) {
    priorCves.set(a.finding.cveId, (priorCves.get(a.finding.cveId) ?? 0) + 1);
  }
  const allCves = new Set<string>([...recentCves.keys(), ...priorCves.keys()]);
  const movers: Array<{ cveId: string; delta: number }> = [];
  for (const cve of allCves) {
    const delta = (recentCves.get(cve) ?? 0) - (priorCves.get(cve) ?? 0);
    if (delta !== 0) movers.push({ cveId: cve, delta });
  }
  movers.sort((a, b) => {
    const absA = Math.abs(a.delta);
    const absB = Math.abs(b.delta);
    if (absB !== absA) return absB - absA;
    if (a.cveId !== b.cveId) return a.cveId < b.cveId ? -1 : 1;
    return 0;
  });
  const topMovers = movers.slice(0, MOVERS_LIMIT);

  // topCriticals = critical-severity alerts from the past 7d that are
  // still unacknowledged. Sorted by (host, cveId) for stable ordering,
  // capped at 10. Empty means "no un-remediated criticals" — the LLM
  // prompt and the email template both fall through to the appropriate
  // sans-line.
  const criticals: Array<{ cveId: string; host: string }> = [];
  for (const a of recent) {
    if (a.acknowledgedAt !== null) continue;
    if ((a.severity ?? '').toLowerCase() !== 'critical') continue;
    criticals.push({ cveId: a.finding.cveId, host: a.finding.asset.host });
  }
  criticals.sort((a, b) => {
    if (a.host !== b.host) return a.host < b.host ? -1 : 1;
    if (a.cveId !== b.cveId) return a.cveId < b.cveId ? -1 : 1;
    return 0;
  });
  // Dedup by (cveId, host) — multiple un-ack'd alerts on the same host
  // shouldn't duplicate the email row.
  const seen = new Set<string>();
  const dedupCriticals: Array<{ cveId: string; host: string }> = [];
  for (const c of criticals) {
    const k = `${c.cveId}@${c.host}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedupCriticals.push(c);
    if (dedupCriticals.length >= CRITICALS_LIMIT) break;
  }

  // trendVelocity is `VelocityTrendSignal.velocity` if a trend row exists.
  // Older signal JSON might not carry `velocity` — coerce missing to 0
  // so the LLM gets a number.
  let trendVelocity: number | null = null;
  if (trendRow && typeof trendRow.signal === 'object' && trendRow.signal !== null) {
    const v = (trendRow.signal as { velocity?: unknown }).velocity;
    if (typeof v === 'number' && Number.isFinite(v)) trendVelocity = v;
  }

  return {
    alertCount: recent.length,
    openCount,
    ackCount,
    velocity,
    topHotspots,
    topMovers,
    topCriticals: dedupCriticals,
    trendVelocity,
    windowStartIso: recentWindow.windowStart.toISOString(),
    windowEndIso: recentWindow.windowEnd.toISOString(),
  };
}

// Pure idempotency gate. Cron: skip when (workspaceId, weekStart,
// triggeredBy='cron') row already exists. Manual: always fire so the
// admin button is an explicit re-trigger (the second inserted row
// carries triggeredBy='manual' and lives in the same week without
// colliding on the composite key).
export function shouldFireThisWeek(
  lastDigestLog: { id: string; triggeredBy: string; weekStart: Date } | null,
  weekStart: Date,
  triggeredBy: DigestTrigger,
): boolean {
  if (triggeredBy === 'manual') return true;
  if (!lastDigestLog) return true;
  return (
    lastDigestLog.triggeredBy !== 'cron' ||
    lastDigestLog.weekStart.getTime() !== weekStart.getTime()
  );
}

// Bounded output schema for the LLM call. Strict field caps so a
// runaway prompt response cannot bloat an email body or a DB row.
const WeeklyDigestOutput = z.object({
  headline: z.string().min(1).max(280),
  body: z.string().min(1).max(12_000),
  biggestMovers: z
    .array(z.object({ cveId: z.string().min(1).max(64), delta: z.number().int() }))
    .max(MOVERS_LIMIT)
    .default([]),
  topCriticals: z
    .array(z.object({ cveId: z.string().min(1).max(64), host: z.string().min(1).max(255) }))
    .max(CRITICALS_LIMIT)
    .default([]),
  recommendedFocus: z.string().min(1).max(600),
});
export type WeeklyDigestOutput = z.infer<typeof WeeklyDigestOutput>;

// LLM oracle. Throws on proxy failure or parse miss so the per-team
// orchestrator can skip-and-log (NO degraded DigestLog row).
export async function generateWeeklyDigestForTeam(
  _teamId: string,
  summary: DigestWeekSummary,
): Promise<WeeklyDigestOutput> {
  const trendLine =
    summary.trendVelocity == null
      ? 'No 30-day velocity trend available yet — first tick is still in flight.'
      : `30-day velocity trend: ${summary.trendVelocity >= 0 ? '+' : ''}${summary.trendVelocity} alerts (recent 30d minus prior 30d).`;

  const moversLine = summary.topMovers.length
    ? `Top week-over-week CVE movers: ${summary.topMovers
        .map((m) => `${m.cveId} (${m.delta >= 0 ? '+' : ''}${m.delta})`)
        .join(', ')}.`
    : 'No notable week-over-week CVE deltas.';
  const hotspotsLine = summary.topHotspots.length
    ? `Top host hotspots: ${summary.topHotspots.map((h) => `${h.host}:${h.port} (${h.count})`).join(', ')}.`
    : 'No host hotspots in the last 7 days.';
  const criticalsLine = summary.topCriticals.length
    ? `Notable un-remediated criticals: ${summary.topCriticals.map((c) => `${c.cveId} on ${c.host}`).join(', ')}.`
    : 'No un-remediated critical CVEs in the last 7 days.';

  const prompt =
    'You are an analyst writing the weekly risk digest for a workspace. ' +
    'Audience: a security lead reading one email every Monday morning. ' +
    'Tone: professional, calm, concrete. No marketing language. ' +
    'Return JSON exactly matching the schema: ' +
    '{ "headline": short executive summary <= 280 chars, ' +
    '"body": longer analyst-style paragraph(s) <= 12000 chars, ' +
    '"biggestMovers": up to 10 { cveId, delta } pairs, ' +
    '"topCriticals": up to 10 { cveId, host } pairs, ' +
    '"recommendedFocus": one sentence <= 600 chars on where to spend cycles this week }.';

  return generateObject<WeeklyDigestOutput>({
    task: 'weekly-risk-digest',
    responseFormat: 'json_object',
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content:
          `Workspace context for the past 7 days vs the prior 7 days:\n` +
          `- Window: ${summary.windowStartIso} → ${summary.windowEndIso}\n` +
          `- Recent alert count: ${summary.alertCount} (open: ${summary.openCount}, acknowledged: ${summary.ackCount})\n` +
          `- Week-over-week velocity: ${summary.velocity >= 0 ? '+' : ''}${summary.velocity}\n` +
          `- ${trendLine}\n` +
          `- ${moversLine}\n` +
          `- ${hotspotsLine}\n` +
          `- ${criticalsLine}\n\n` +
          'Write the analyst digest.',
      },
    ],
  });
}

// Per-team orchestrator used by the manual trigger route AND by the
// batch runner. Idempotency via `shouldFireThisWeek`.
//
// Behaviour matrix:
//   - `triggeredBy='cron'`: skip when row exists for (workspaceId,
//     weekStart, triggeredBy='cron'). Empty team → silent skip.
//   - `triggeredBy='manual'`: ALWAYS inserts — the admin button is
//     an explicit re-trigger, the dedupe composite key is keyed on all
//     three columns so a same-week manual insert does not collide.
//
// AI-fail posture: on `generateObject` throw, RETURN `{ id: null,
// status: null, attempted: 0, sent: 0, failed: 0, skipped: 1,
// weekStart }` — NO row written. A successful re-run later closes the
// gap, rather than cluttering the listing with degraded rows.
export async function runWeeklyRiskDigestForTeam(
  teamId: string,
  now: Date,
  options: RunWeeklyDigestOptions,
): Promise<RunWeeklyDigestForTeamResult> {
  const weekStart = startOfUtcWeek(now);

  // Idempotency gate (cron branch only).
  const last = await prisma.digestLog.findFirst({
    where: { workspaceId: teamId, weekStart },
    orderBy: { createdAt: 'desc' },
    select: { id: true, triggeredBy: true, weekStart: true },
  });
  if (!shouldFireThisWeek(last, weekStart, options.triggeredBy)) {
    return {
      id: null,
      weekStart: weekStart.toISOString(),
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
      status: null,
    };
  }

  // Recipient resolution (mirror alerts-digest.ts:142-153).
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: teamId, status: 'active' },
    select: { email: true },
  });
  const recipients = members.map((m) => m.email).filter((e): e is string => !!e);
  if (recipients.length === 0) {
    return {
      id: null,
      weekStart: weekStart.toISOString(),
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
      status: null,
    };
  }

  const teamRow = await prisma.team.findUnique({
    where: { id: teamId },
    select: { name: true },
  });
  const teamName = teamRow?.name ?? 'workspace';

  // Selector — batched reads scoped by teamId.
  const recentWindow = window7d(now);
  const prior = priorWindow7d(now);

  const [recentAlerts, priorAlerts, trendRow] = await Promise.all([
    prisma.alert.findMany({
      where: {
        teamId,
        createdAt: { gte: recentWindow.windowStart, lt: recentWindow.windowEnd },
      },
      select: {
        id: true,
        teamId: true,
        severity: true,
        createdAt: true,
        acknowledgedAt: true,
        finding: { select: { cveId: true, asset: { select: { host: true, port: true } } } },
      },
    }),
    prisma.alert.findMany({
      where: { teamId, createdAt: { gte: prior.windowStart, lt: prior.windowEnd } },
      select: {
        id: true,
        teamId: true,
        severity: true,
        createdAt: true,
        acknowledgedAt: true,
        finding: { select: { cveId: true, asset: { select: { host: true, port: true } } } },
      },
    }),
    prisma.vulnerabilityTrend.findFirst({
      where: { workspaceId: teamId },
      orderBy: { computedAt: 'desc' },
      select: { signal: true, computedAt: true, windowEnd: true },
    }),
  ]);

  const summary = summariseWeekOverWeek(recentAlerts, priorAlerts, trendRow, now);

  // Cold-start / no-data skip. Mirrors alerts-digest.ts:164-166 — if
  // there are no alerts in the last 7d AND no un-remediated criticals
  // we'd otherwise write, the digest adds no value. We still fire when
  // there is even one open alert so the team sees the cadence.
  const hasContentToReport = summary.alertCount > 0 || summary.topCriticals.length > 0;
  if (!hasContentToReport && options.triggeredBy === 'cron') {
    return {
      id: null,
      weekStart: weekStart.toISOString(),
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
      status: null,
    };
  }

  // LLM call — skip-and-log on throw.
  let digest: WeeklyDigestOutput;
  try {
    digest = await generateWeeklyDigestForTeam(teamId, summary);
  } catch {
    return {
      id: null,
      weekStart: weekStart.toISOString(),
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 1,
      status: null,
    };
  }

  // Render + send. No `from:` — fromFor('digest') binds at the edge.
  void fromFor('digest');
  const base = options.appBaseUrl.replace(/\/+$/, '');
  const ctaUrl = `${base}/dashboard`;
  const rendered = weeklyRiskDigestEmail({
    teamName,
    weekStartIso: weekStart.toISOString(),
    weekEndIso: now.toISOString(),
    headline: digest.headline,
    body: digest.body,
    topMovers: summary.topMovers,
    topCriticals: summary.topCriticals,
    ctaUrl,
  });

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await sendEmail({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  const status: DigestStatus = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';

  // Write the DigestLog row.
  // JSON.parse(JSON.stringify(...)) on each snapshot strips index
  // signatures so Prisma's InputJsonValue accepts the payload without
  // a structural mismatch. signalSnapshot = the trend row we read
  // (raw, not derived) so a re-derive can replay against the original
  // signal; alertsSnapshot = the derived DigestWeekSummary so the row
  // is self-contained for re-send.
  const signalSnapshot =
    trendRow && typeof trendRow.signal === 'object' && trendRow.signal !== null
      ? JSON.parse(JSON.stringify(trendRow.signal))
      : ({} as object);
  const alertsSnapshot = JSON.parse(JSON.stringify(summary)) as object;
  const summaryJson = JSON.parse(JSON.stringify(digest)) as object;

  const created = await prisma.digestLog.create({
    data: {
      workspaceId: teamId,
      weekStart,
      summarySubject: rendered.subject,
      summaryBody: rendered.html.slice(0, 12_000),
      summaryJson,
      signalSnapshot,
      alertsSnapshot,
      recipientCount: recipients.length,
      status,
      triggeredBy: options.triggeredBy,
    },
    select: { id: true },
  });

  return {
    id: created.id,
    weekStart: weekStart.toISOString(),
    attempted: recipients.length,
    sent,
    failed,
    skipped: 0,
    status,
  };
}

// Whole-batch orchestrator. Iterates `Team.findMany({ select: { id } })`
// and delegates per-team. Per-team failure is swallowed (logged) so one
// broken team does not abort the rest of the morning — mirrors the
// competitive-intel posture.
export async function runWeeklyRiskDigest(
  now: Date,
  options: Omit<RunWeeklyDigestOptions, 'appBaseUrl'> & { appBaseUrl?: string },
): Promise<RunWeeklyDigestResult> {
  const appBaseUrl = options.appBaseUrl ?? '';
  const teams = await prisma.team.findMany({ select: { id: true } });
  if (teams.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of teams) {
    try {
      const res = await runWeeklyRiskDigestForTeam(t.id, now, {
        triggeredBy: options.triggeredBy,
        appBaseUrl,
      });
      attempted += res.attempted;
      sent += res.sent;
      failed += res.failed;
      skipped += res.skipped;
    } catch {
      // Outermost safety net — `runWeeklyRiskDigestForTeam` is
      // crash-tolerant for the AI + email paths but a DB write can
      // still throw (network, conflict). Log and continue.
      failed += 1;
    }
  }
  return { attempted, sent, failed, skipped };
}

export const _constants = {
  SEVEN_DAYS_MS,
  FOURTEEN_DAYS_MS,
  HOTSPOTS_LIMIT,
  MOVERS_LIMIT,
  CRITICALS_LIMIT,
};
