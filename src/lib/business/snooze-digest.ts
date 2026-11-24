// @polsia:user-owned — business lib for the on-demand snooze digest fired
// from /alerts (POST /api/alerts/snooze-digest) and reusable from a
// future scheduled trigger without rework. Companion to
// src/lib/business/daily-user-digest.ts (08:30 per-user daily) and
// src/lib/business/daily-alert-digest.ts (09:00 per-team daily) with a
// deliberately different scope, recipient shape, link target, and stamp
// column.
//
// Selection rule (24h stamped OR still-active snooze window, owned by
// the calling member):
//   - User.email resolved via User.findUnique.
//   - Caller's WorkspaceMember resolved via Membership.userId @unique
//     → Membership.teamId → WorkspaceMember.findFirst({ teamId,
//     userId, status:'active' }) — the user can only ever have one
//     Membership row (userId @unique) so the findFirst is a 1-row
//     read with no in-band ambiguity.
//   - Alert.findMany where { teamId, ownerId: <callerWorkspaceMemberId>,
//     snoozedUntil: { gte: now-24h, not: null } } — recent + still-
//     active. The 24h lower bound catches snoozes stamped in the last
//     day (so "snoozed this morning" lands on today's bucket even
//     though the snoozedUntil hasn't elapsed yet); the `not: null`
//     strips the unset sentinel so we don't surface un-snoozed rows.
//
// Author attribution is unknown per the brief's note — the route
// stores `snoozedUntil` on Alert but does NOT audit who stamped it,
// so the digest's scope is "rows the caller currently owns AND is
// currently snoozed" (interpretation #1 from the plan header). A row
// the caller snoozed but no longer owns, or a row the caller owns but
// a teammate snoozed, is out of scope — both are structurally
// undetectable from the current schema without audit columns.
//
// Bucket ordering:
//   - Today's bucket first (entries where `snoozedUntil`'s UTC date
//     matches `now`'s UTC date). Prior days desc; the most recent
//     prior day sits just below today.
//   - Bucketed by the UTC calendar day of `snoozedUntil`, not by the
//     snooze-stamp instant — a row snoozed "now" with a 7-day window
//     stamps `snoozedUntil = now + 7d`, and that maps cleanly to
//     today. The same row re-bucketed into today's bucket for the
//     next 6 days, then drops to a fresh day-label.
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
import { snoozeDigestEmail } from '@/lib/email/templates';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface SnoozeDigestItem {
  id: string;
  severity: string;
  cveId: string;
  host: string;
  /** Precomputed `${appBaseUrl}/alerts/${id}` so the template does not
   *  re-derive the URL — same per-row anchor the brief calls for. */
  url: string;
  /** Precomputed `untilInHours` (floored) so the template does not
   *  re-derive the "X hours remaining" hint AND the text/plain
   *  rendering can stamp it without losing the value off the wire.
   *  Lives in the same envelope so the cron-reuser loop can stamp
   *  the same exact shape. */
  untilInHours: number;
  /** Raw `snoozedUntil` Date so a future regression can re-derive
   *  day-buckets from a different anchor without round-tripping. */
  snoozedUntil: Date;
}

export interface SnoozeDigestGroup {
  /** "Today (N)" or "Yesterday (N)" or "YYYY-MM-DD (N)". */
  dayLabel: string;
  /** Items in this bucket ordered by `snoozedUntil` ASC, so the freshest
   *  snooze-window tail-of-day row sits last; the soonest-expires row
   *  sits first. The grouping purely keys on the snoozedUntil date so
   *  each row is read in one pass from a single Alert.findMany. */
  items: SnoozeDigestItem[];
}

export interface SnoozeDigestInput {
  userId: string;
  email: string;
  teamId: string;
  teamName: string;
  /** Per-day buckets in display order (today first, prior days desc).
   *  Empty array means: no team row, OR zero matching alerts. Both are
   *  a 200 with `{ sent: false, totalAlerts: 0 }` at the route. */
  groups: SnoozeDigestGroup[];
  totalAlerts: number;
  appBaseUrl: string;
}

export interface SendSnoozeDigestOptions {
  appBaseUrl: string;
}

export interface SendSnoozeDigestResult {
  sent: boolean;
  reason?: 'no_email' | 'no_snoozed' | 'send_failed';
  totalAlerts: number;
}

/**
 * Pure selector. Resolves the calling user's email + WorkspaceMember
 * id, fetches the snoozed alerts the caller currently owns whose
 * `snoozedUntil` is non-null AND lands in [now-24h, +∞), groups them
 * by the UTC calendar day of `snoozedUntil`, and returns a
 * `SnoozeDigestInput` whose `groups[]` are stamped with the future
 * `appBaseUrl` already-trimmed. Returns `null` when the caller has no
 * Membership row (defensive — onboarding always writes one) so the
 * route can map the branch to a 404 opaque envelope.
 *
 * `now` is passed in for testability; the caller resolves it from
 * `new Date()` (the cron entry) or from the route's `req` wall-clock
 * when it wants to share the timestamp with downstream artifacts.
 */
export async function findSnoozeDigestInput(
  userId: string,
  now: Date,
  appBaseUrl: string,
): Promise<SnoozeDigestInput | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) {
    // No email (defensive — better-auth's seed row stamps one) — we
    // bail to `null` and the route maps to a 404 opaque "no_team"
    // branch so the response shape stays single-arm. A future
    // re-run stamps a real email on the User row's profile and the
    // next click sends.
    return null;
  }

  const membership = await prisma.membership.findUnique({
    where: { userId },
    select: { teamId: true },
  });
  if (!membership) return null;
  const teamId = membership.teamId;

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { name: true },
  });
  const teamName = team?.name ?? 'Workspace';

  const wm = await prisma.workspaceMember.findFirst({
    where: { userId, workspaceId: teamId, status: 'active' },
    select: { id: true },
  });
  const callerWorkspaceMemberId = wm?.id ?? null;

  if (!callerWorkspaceMemberId) {
    // Defensive: signed-in but no active WorkspaceMember row — the
    // workspace bootstrap creates one, so this is the unreachable
    // branch. The route maps it to 404 the same way the membership
    // miss does.
    return null;
  }

  // Note: `snoozedUntil` lower bound is the previous day's UTC
  // midnight for "still newer than now-24h" (so a snooze stamped at
  // 23:50 yesterday with a 7-day window still lands in today).
  // `gte: now - 24h` keeps the OR'd window scope tight on
  // (teamId, ownerId, snoozedUntil) — the composite index on
  // (teamId, ownerId) at alerts.prisma:214 covers the per-team
  // owner-pick path.
  const floorDate = new Date(now.getTime() - DAY_MS);

  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      ownerId: callerWorkspaceMemberId,
      snoozedUntil: { gte: floorDate, not: null },
    },
    select: {
      id: true,
      severity: true,
      snoozedUntil: true,
      finding: {
        select: {
          cveId: true,
          asset: { select: { host: true, port: true, protocol: true } },
        },
      },
    },
    orderBy: { snoozedUntil: 'asc' },
  });

  const base = appBaseUrl.replace(/\/+$/, '');

  // Stash on `SnoozeDigestItem.url` straight away so a future
  // regression (e.g. switching to a relative path) doesn't have
  // to plumb `appBaseUrl` through the bucketing step.
  const items: SnoozeDigestItem[] = rows
    .filter((row) => row.snoozedUntil != null)
    .map((row) => {
      const until = row.snoozedUntil as Date;
      const remainingMs = Math.max(0, until.getTime() - now.getTime());
      return {
        id: row.id,
        severity: (row.severity ?? 'unknown').toLowerCase(),
        cveId: row.finding?.cveId ?? '',
        host: row.finding?.asset?.host ?? '',
        snoozedUntil: until,
        untilInHours: Math.floor(remainingMs / HOUR_MS),
        url: `${base}/alerts/${row.id}`,
      };
    });

  return {
    userId,
    email: user.email,
    teamId,
    teamName,
    groups: groupSnoozeByDay(items, now),
    totalAlerts: items.length,
    appBaseUrl: base,
  };
}

/**
 * Pure day-bucketing helper. Bucket key = `snoozedUntil`'s UTC
 * calendar day (using ISO YYYY-MM-DD so the key is stable across
 * timezone shifts). Today first, prior days desc — the per-day
 * labels use "Today (N)" / "Yesterday (N)" / "YYYY-MM-DD (N)" so
 * the rendered list reads naturally without calendar arithmetic on
 * the template.
 *
 * Exported so the route + a unit test can pin the bucket order
 * without spinning up Prisma.
 */
export function groupSnoozeByDay(items: SnoozeDigestItem[], now: Date): SnoozeDigestGroup[] {
  if (items.length === 0) return [];

  const todayUtc = utcDayKey(now);

  type Bucket = { key: string; items: SnoozeDigestItem[] };
  const bucketsByKey = new Map<string, Bucket>();
  const orderedKeys: string[] = [];

  for (const item of items) {
    const key = utcDayKey(item.snoozedUntil);
    let bucket = bucketsByKey.get(key);
    if (!bucket) {
      bucket = { key, items: [] };
      bucketsByKey.set(key, bucket);
      orderedKeys.push(key);
    }
    bucket.items.push(item);
  }

  // Sort the per-day keys descending (newest first) so today comes
  // out on top — the YYYY-MM-DD string is a valid lexical compare
  // for any pair produced by the same UTC calendar.
  orderedKeys.sort((a, b) => (a === todayUtc ? -1 : b === todayUtc ? 1 : b.localeCompare(a)));

  return orderedKeys.map((key) => {
    const bucket = bucketsByKey.get(key);
    if (!bucket) return { dayLabel: `${key} (0)`, items: [] };
    const n = bucket.items.length;
    let dayLabel: string;
    if (key === todayUtc) dayLabel = `Today (${n})`;
    else dayLabel = `${key} (${n})`;
    return { dayLabel, items: bucket.items };
  });
}

/** UTC calendar-day key extractor — YYYY-MM-DD slice so the result
 *  is timezone-orthogonal and lexical-comparable. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Send the digest envelope. Wraps `sendEmail` in try/catch so a
 * transient proxy failure returns `{ sent: false, reason: 'send_failed'
 * }` instead of throwing — the route maps the reason to a 502.
 *
 * `totalAlerts === 0` short-circuits before any send so a re-click
 * on the same view (no snoozed alerts) doesn't burn the proxy's
 * 50/day rate limit. The selector's
 * `groups[].items.length === 0` is the natural no-op guard the route
 * already relies on, but this function re-defends so a future cron
 * caller can rely on the same pre-flight.
 */
export async function sendSnoozeDigestToUser(
  input: SnoozeDigestInput,
  _now: Date,
  _options: SendSnoozeDigestOptions,
): Promise<SendSnoozeDigestResult> {
  if (!input.email) {
    return { sent: false, reason: 'no_email', totalAlerts: input.totalAlerts };
  }
  if (input.totalAlerts === 0) {
    return { sent: false, reason: 'no_snoozed', totalAlerts: 0 };
  }

  void fromFor('digest');

  const rendered = snoozeDigestEmail({
    teamName: input.teamName,
    groups: input.groups,
  });

  try {
    await sendEmail({
      to: input.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return { sent: true, totalAlerts: input.totalAlerts };
  } catch {
    return { sent: false, reason: 'send_failed', totalAlerts: input.totalAlerts };
  }
}
