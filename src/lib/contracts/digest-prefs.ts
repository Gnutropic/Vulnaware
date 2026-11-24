// @polsia:user-owned — Wire contracts for /api/account/digest. Pure zod,
// no server-only/db imports so both the route handler and the client
// island can share the single source of truth (a contract drift
// surfaces as a `tsc` error / runtime ZodError rather than a silent
// shape mismatch).
//
// Tracks the per-user "Receive daily digest" preferences on /account:
//   - `digestEnabled` — global opt-in (boolean, default true).
//   - `severityThreshold` — inclusive-lower severities the digest
//     includes (`critical` | `high` | `medium` | `low`); null = "all
//     severities". The cron expands this to a Prisma
//     `where: { severity: { in: [threshold-and-up] } }` so a single
//     knob matches the /alerts severity chip's semantics.
//   - `assetScope` — list of composite `${host}:${port}/${protocol}`
//     strings the digest should sample. Empty = "all assets on the
//     team". Same wire shape the /alerts `?asset=…` deep-link already
//     emits, so saving the Set round-trips byte-for-byte into the
//     alerter's filter set.
//   - `lastSentAt` — ISO-8601 stamp of the last successful dictation
//     driven entry's live send. Server-controlled only — never
//     accepted on PUT.
//   - `updatedAt` — DB row's last-write stamp (ISO-8601, UTC ms
//     serialised from Date.toISOString()) so the UI can re-mount and
//     re-check the value after Save without a race.

import { z } from 'zod';

export const SEVERITY_THRESHOLD_VALUES = ['low', 'medium', 'high', 'critical'] as const;
export type SeverityThreshold = (typeof SEVERITY_THRESHOLD_VALUES)[number];

// GET /api/account/digest response item. All five keys are non-optional
// on the wire (severityThreshold + assetScope + lastSentAt use `null` /
// `[]` rather than absence so the client doesn't have to branch on
// undefined for every read).
export const DigestPrefsItem = z.object({
  digestEnabled: z.boolean(),
  severityThreshold: z.string().nullable(),
  assetScope: z.array(z.string()).max(50),
  lastSentAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type DigestPrefsItem = z.infer<typeof DigestPrefsItem>;

// GET /api/account/digest response — same shape as the item so the
// client reuses one zod node for both verbs.
export const DigestPrefsGetResponse = DigestPrefsItem;
export type DigestPrefsGetResponse = z.infer<typeof DigestPrefsGetResponse>;

// PUT /api/account/digest body — all three preference knobs are
// OPTIONAL so the route accepts a partial save (the UI sends only the
// knobs it actually changed; the absent keys keep their previous
// value). A body with NO keys present is rejected at the route layer
// with a 400 so a no-op PUT doesn't silently round-trip. server-stamped
// fields (`lastSentAt`, `updatedAt`, `id`) are NOT accepted; the route
// ignores/suppresses them even if a future zod widening inadvertently
// allows them through.
export const DigestPrefsSetBody = z.object({
  digestEnabled: z.boolean().optional(),
  severityThreshold: z.string().nullable().optional(),
  assetScope: z.array(z.string()).max(50).optional(),
});
export type DigestPrefsSetBody = z.infer<typeof DigestPrefsSetBody>;
export type DigestPrefsSetBodyInput = z.input<typeof DigestPrefsSetBody>;

// PUT /api/account/digest response — echoes the full saved state so
// the UI can immediately re-mount with the server-stamped `updatedAt`
// + `lastSentAt` without a second round-trip.
export const DigestPrefsSetResponse = DigestPrefsItem;
export type DigestPrefsSetResponse = z.infer<typeof DigestPrefsSetResponse>;
