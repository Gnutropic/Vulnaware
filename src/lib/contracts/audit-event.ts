import { z } from 'zod';

export const AuditEventItem = z.object({
  id: z.string(),
  actorUserId: z.string(),
  actorTeamId: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
});

export const AuditEventList = z.object({
  items: z.array(AuditEventItem),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

export const AuditEventQuery = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type AuditEventItem = z.infer<typeof AuditEventItem>;
export type AuditEventList = z.infer<typeof AuditEventList>;
export type AuditEventQuery = z.infer<typeof AuditEventQuery>;
