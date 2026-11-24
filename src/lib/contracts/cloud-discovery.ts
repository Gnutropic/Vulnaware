// @polsia:user-owned — zod contracts for /api/v1/cloud/discovery/schedule.
// Pure zod (no server-only imports) so both the server route handler and a
// future client island can share the wire shape. Mirrors the api-key.ts /
// aws.ts / azure.ts / gcp.ts style.

import { z } from 'zod';

// Provider enum. Persisted on CloudDiscoverySchedule.provider as a String —
// matches the pattern used by AwsRunStatus / ApiKeyScopeKind so the wire
// schema is the single source of truth for valid values.
export const CloudDiscoveryProvider = z.enum(['aws', 'azure', 'gcp']);
export type CloudDiscoveryProvider = z.infer<typeof CloudDiscoveryProvider>;

// Minimum cadence floor — cron + DB cost make anything shorter wasteful and
// a misconfigured 5-minute schedule could trivially DoS a customer's bill.
// The contract enforces 60 minutes; the route handler re-checks at the write
// boundary as defense-in-depth.
export const MIN_CADENCE_MINUTES = 60;

// POST /api/v1/cloud/discovery/schedule body. `teamId` is NEVER trusted from
// the client — the route resolves the caller's team from their membership
// row instead.
export const CloudDiscoveryScheduleCreate = z.object({
  provider: CloudDiscoveryProvider,
  cadenceMinutes: z.number().int().min(MIN_CADENCE_MINUTES, 'Minimum cadence is 60 minutes'),
});

// Read shape — single row. Locked-shape output, not a Prisma toJSON.
export const CloudDiscoveryScheduleItem = z.object({
  id: z.string(),
  teamId: z.string(),
  provider: CloudDiscoveryProvider,
  cadenceMinutes: z.number().int().min(MIN_CADENCE_MINUTES),
  lastRunAt: z.string().nullable(), // ISO-8601 from toISOString()
  nextRunAt: z.string(),
  createdById: z.string(),
  createdAt: z.string(),
});

// GET /api/v1/cloud/discovery/schedule response — list wrapper. Single-row
// responses and list responses are separate schemas on purpose: a future
// paginated list can extend this without touching the per-row schema.
export const CloudDiscoveryScheduleList = z.object({
  items: z.array(CloudDiscoveryScheduleItem),
});

export type CloudDiscoveryScheduleCreate = z.infer<typeof CloudDiscoveryScheduleCreate>;
export type CloudDiscoveryScheduleCreateInput = z.input<typeof CloudDiscoveryScheduleCreate>;
export type CloudDiscoveryScheduleItem = z.infer<typeof CloudDiscoveryScheduleItem>;
export type CloudDiscoveryScheduleList = z.infer<typeof CloudDiscoveryScheduleList>;
export type CloudDiscoveryScheduleListInput = z.input<typeof CloudDiscoveryScheduleList>;
