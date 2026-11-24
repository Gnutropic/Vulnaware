import 'server-only';
import { prisma } from '@/lib/db';

// Matches Prisma's InputJsonObject — all nested values must be JSON-safe.
type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export interface AuditParams {
  actorUserId: string;
  actorTeamId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: JsonObject;
  ipAddress: string | null;
}

export async function audit(params: AuditParams): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actorUserId: params.actorUserId,
      actorTeamId: params.actorTeamId,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      metadata: params.metadata ?? undefined,
      ipAddress: params.ipAddress,
    },
  });
}

export function extractIp(req: Request): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  );
}
