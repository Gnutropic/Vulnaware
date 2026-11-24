// @polsia:user-owned — Wire contracts for the per-team 09:00 UTC daily
// alert digest manual trigger. Mirrors src/lib/contracts/digest.ts shape
// so the existing admin-trigger island can compose against both digests
// with one shared parse path.
//
// Two shapes:
//   - DailyDigestRunRequest — POST body for /api/admin/daily-digest/run.
//     Mirrors WeeklyDigestRunRequest so a same-shape curl works from
//     the eval harness (acceptance §9).
//   - DailyDigestRunResult — POST response. id is null when the
//     per-UTC-day stamp is fresh (the route returns the same envelope
//     shape regardless so the admin island can render consistently).
//
// We deliberately omit `triggeredBy` from the request: the manual route
// is the ONLY writer for this action, so there's nothing to disambiguate.
// Cron-driven runs use the same business lib path internally but never
// land in this route.

import { z } from 'zod';

// POST body for /api/admin/daily-digest/run. `now` is an optional
// ISO-8601 string for deterministic re-triggers; absent → server
// `new Date()`. The route also accepts an empty body (`{}`) so the
// admin button can POST without assembling a body.
export const DailyDigestRunRequest = z.object({
  now: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid ISO date string.' })
    .optional(),
});

export type DailyDigestRunRequest = z.infer<typeof DailyDigestRunRequest>;
export type DailyDigestRunRequestInput = z.input<typeof DailyDigestRunRequest>;

// Per-severity counts from the selector's `prisma.alert.groupBy({ by:
// ['severity'], where: { teamId, OR: [createdAt, statusChangedAt] } })`
// bucketed into the four severity buckets the email renders. Missing
// keys default to 0 so the rendered counts always carry every line.
export const DailyDigestSeverityCounts = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});

export type DailyDigestSeverityCounts = z.infer<typeof DailyDigestSeverityCounts>;

// POST response — the per-team run summary so the eval harness can
// assert the wire shape. `id` is null when the same-day stamp is fresh
// (skipped) — surfaced verbatim so the curl response stays uniformly
// shaped regardless of the gate decision.
//
// Window bounds are returned so a re-trigger with `now` can be
// cross-referenced against the actual selector window used.
export const DailyDigestRunResult = z.object({
  id: z.string().nullable(),
  teamId: z.string(),
  severityCounts: DailyDigestSeverityCounts,
  attempted: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  windowStartIso: z.string(),
  windowEndIso: z.string(),
});

export type DailyDigestRunResult = z.infer<typeof DailyDigestRunResult>;
