// @polsia:user-owned — zod contract for /api/team/settings. Mirrors
// src/lib/contracts/alerts.ts style: pure zod, NO server-only imports so
// the route handler and the toggle client island share a single wire shape.
//
// Wire surface:
//   - TeamSettings        GET response (read).
//   - TeamSettingsPatch   PATCH request body (write).
//
// `lastAlertDigestAt` is ISO-8601 (Date.toISOString()) on the wire and a
// Date on the server; both sides parse through the same schema so a
// client that reads `null` doesn't have to special-case a missing value.

import { z } from 'zod';

export const TeamSettings = z.object({
  digestEnabled: z.boolean(),
  // ISO-8601 string when a digest (or empty-day all-clear) has fired for
  // this team; null when one has not yet been stamped. The toggle UI
  // surfaces a human timestamp by parsing this string client-side.
  lastAlertDigestAt: z.string().datetime().nullable(),
});

export const TeamSettingsPatch = z.object({
  digestEnabled: z.boolean(),
});

export type TeamSettings = z.infer<typeof TeamSettings>;
export type TeamSettingsPatch = z.infer<typeof TeamSettingsPatch>;
export type TeamSettingsPatchInput = z.input<typeof TeamSettingsPatch>;
