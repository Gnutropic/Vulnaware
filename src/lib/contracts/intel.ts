// @polsia:user-owned — Public-facing wire contract for the per-team
// competitive-intelligence audit feed. Mirrors alerts.ts: pure zod shapes,
// NO server-only / db imports so both the /api/intel/runs handler and
// the /settings/intel client island share the same validation.
//
// The list payload intentionally OMITS `body` to keep listings trim; the
// detail endpoint (`/api/intel/runs/[id]`) returns `body` on demand so a
// click-to-expand affordance can lazy-load the full audit text without
// bloating every row up-front.

import { z } from 'zod';

// One row in GET /api/intel/runs. `body` is NOT here — the detail call
// rounds-trip the full audit text only when the user expands a card.
export const IntelRunListItem = z.object({
  id: z.string(),
  // ranAt is the start-of-UTC-day stamp (00:00:00.000Z) the cron
  // derived from its fire time; surface as ISO Z so the client can
  // format without timezone meddling.
  ranAt: z.string(),
  headline: z.string(),
});
export type IntelRunListItem = z.infer<typeof IntelRunListItem>;

// GET /api/intel/runs response envelope. The route caps the page at 50
// rows newest-first so the listing stays light even with many months of
// nightly fires behind it.
export const IntelRunList = z.object({
  items: z.array(IntelRunListItem),
});
export type IntelRunList = z.infer<typeof IntelRunList>;

// GET /api/intel/runs/[id] response. Includes `body` — the full audit
// text for expand-on-click affordance. Bounded to ≤ 20k chars at write
// time (see `generateAuditHeadlineBodyForTeam` in
// src/lib/business/competitive-intel.ts) so a runaway model output
// cannot bloat the row indefinitely.
export const IntelRunDetail = z.object({
  id: z.string(),
  ranAt: z.string(),
  headline: z.string(),
  body: z.string(),
});
export type IntelRunDetail = z.infer<typeof IntelRunDetail>;
