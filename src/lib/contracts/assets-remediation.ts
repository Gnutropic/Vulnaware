// @polsia:user-owned — Wire contract for the per-host remediation
// timeline feed at GET /api/assets/<host>/remediation-timeline. Pure
// zod schemas (no `server-only`, no @prisma/client, no @/lib/db) so
// the route handler at
// src/app/api/assets/[host]/remediation-timeline/route.ts AND the
// client island at
// src/components/dashboard/asset-remediation-timeline.tsx both
// parse against the same source of truth. Mirrors the posture of
// src/lib/contracts/assets-detail.ts.
//
// Source discriminator is the SERVER'S choice — see notes in
// src/lib/business/assets-remediation.ts. The wire enum
// `source: 'remediated' | 'resolved'` lets the UI label each dot
// meaningfully without re-fetching per-event metadata.
//
// Re-exports `AssetDetailPathParam` from assets-detail so the new
// route can import BOTH schemas from this single user-owned file.

import { z } from 'zod';
import { AssetDetailPathParam } from '@/lib/contracts/assets-detail';

export { AssetDetailPathParam };

export const SEVERITY_TIERS = ['critical', 'high', 'medium', 'low'] as const;
export type SeverityTier = (typeof SEVERITY_TIERS)[number];

// One row per Alert that has at LEAST ONE resolution-shaped stamp:
//   - `Alert.remediatedAt IS NOT NULL`, OR
//   - `Alert.closedAt IS NOT NULL AND Alert.status = 'resolved'`.
//
// The server picks the most-informative stamp per alert (a `remediatedAt`
// stamp always wins over a `closedAt` stamp on the same row) so the wire
// emits AT MOST one event per alertId.
export const RemediationEvent = z.object({
  alertId: z.string(),
  // '' is server-side acceptable when the joined `VulnerabilityFinding`
  // has no cveId (manual rows etc.); UI renders "—" for it.
  cveId: z.string(),
  // Peer-read off CveEntry.description (best-effort; null on a cold-
  // start / pre-ingest CveEntry-cache miss).
  cveTitle: z.string().nullable(),
  // Free-form string column on Alert (lower-cased on the server to
  // tier-ordinal convention; nullable when the row has no severity).
  severity: z.string().nullable(),
  // ISO-8601 UTC. The wire guarantees NON-NULL because the server
  // stamps this from a row that already passed the resolution stamp
  // filter — a null on the wire is impossible by construction.
  resolvedAt: z.string(),
  // Which stamp won the dedupe on the server:
  //   - 'remediated' → Alert.remediatedAt IS NOT NULL.
  //   - 'resolved'   → Alert.closedAt IS NOT NULL AND status='resolved'.
  source: z.enum(['remediated', 'resolved']),
});
export type RemediationEvent = z.infer<typeof RemediationEvent>;

export const RemediationTimeline = z.object({
  host: z.string(),
  events: z.array(RemediationEvent),
  // Oldest + newest event stamps (ISO). Both `null` when events is
  // empty so the client can compute its empty-state UI without a
  // length check on the array.
  rangeStart: z.string().nullable(),
  rangeEnd: z.string().nullable(),
});
export type RemediationTimeline = z.infer<typeof RemediationTimeline>;
