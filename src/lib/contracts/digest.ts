// @polsia:user-owned — Public-facing wire contracts for the per-team
// weekly AI-generated risk-trend email digest. Mirrors audit-event.ts:
// pure zod, NO server-only / db imports so the route handler, the cron
// business lib, and the client island can share a single source of truth.
//
// Three shapes:
//   - WeeklyDigestRunRequest   POST body for /api/admin/digest/run
//   - WeeklyDigestRunResult    POST response — id + envelope counts
//   - WeeklyDigestLogRow       one row from prisma.digestLog, surfaced
//     to GET /api/admin/digest as `items: WeeklyDigestLogRow[]`
//
// `triggeredBy` is bounded so a typo'd cron-vs-manual flip 400s through
// the schema instead of silently narrowing the dedupe composite key
// (workspaceId, weekStart, triggeredBy).
//
// `summarySnapshot` / `alertsSnapshot` are NOT surfaced on the wire —
// they're stored on the row for re-send and audit but the admin page
// only needs the headline + the recipient counts to render.

import { z } from 'zod';

export const DigestTriggeredBy = z.enum(['cron', 'manual']);
export type DigestTriggeredBy = z.infer<typeof DigestTriggeredBy>;

export const DigestStatus = z.enum(['sent', 'failed', 'partial']);
export type DigestStatus = z.infer<typeof DigestStatus>;

// POST body for /api/admin/digest/run. `now` is an optional ISO-8601
// string for deterministic re-triggers; absent → server `new Date()`.
// The route also accepts an empty body (`{}`) so the admin button can
// POST without assembling a body.
export const WeeklyDigestRunRequest = z.object({
  now: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid ISO date string.' })
    .optional(),
});

export type WeeklyDigestRunRequest = z.infer<typeof WeeklyDigestRunRequest>;
export type WeeklyDigestRunRequestInput = z.input<typeof WeeklyDigestRunRequest>;

// POST response — the inserted DigestLog row id + envelope counts so
// the admin island optimistically prepends the new row to its table.
export const WeeklyDigestRunResult = z.object({
  id: z.string(),
  // attempted = # of envelopes we tried to deliver (recipients.length).
  attempted: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  // skipped = # of teams we didn't attempt because the (workspaceId,
  // weekStart, triggeredBy) dedupe key already existed (cron branch
  // only — manual branch always inserts).
  skipped: z.number().int().nonnegative(),
  weekStart: z.string(),
});

export type WeeklyDigestRunResult = z.infer<typeof WeeklyDigestRunResult>;

// GET /api/admin/digest response shape — a thin envelope around a list
// of recent rows so the wire matches the ListItem convention used by
// /api/alerts and /api/audit-events.
export const WeeklyDigestLogRow = z.object({
  id: z.string(),
  weekStart: z.string(),
  status: DigestStatus,
  triggeredBy: DigestTriggeredBy,
  summarySubject: z.string(),
  recipientCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export type WeeklyDigestLogRow = z.infer<typeof WeeklyDigestLogRow>;

export const WeeklyDigestLogList = z.object({
  items: z.array(WeeklyDigestLogRow),
});

export type WeeklyDigestLogList = z.infer<typeof WeeklyDigestLogList>;
