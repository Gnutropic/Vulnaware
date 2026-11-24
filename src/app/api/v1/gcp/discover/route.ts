// @polsia:user-owned — v1 enterprise REST: POST /api/v1/gcp/discover.
// Gated with verifyApiKey(); authenticated team can trigger a discovery job
// on any of its members' GcpConnection rows. The bearer key's teamId is the
// ownership domain; the connection userId must belong to the team.

import 'server-only';
import { NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/api-auth';
import { dispatchDiscoveryRun } from '@/lib/business/cloud/discovery-schedule';
import {
  GcpDiscoveryCreateResponse,
  GcpRunStatus,
  V1GcpDiscoverBody,
  V1GcpDiscoverResponse,
} from '@/lib/contracts/gcp';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const auth = await verifyApiKey(req);
      if (auth instanceof NextResponse) return auth;

      setRequestAuth({
        teamId: auth.teamId,
        keyId: auth.keyId,
        scopeKind: auth.scopeKind,
      });

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return NextResponse.json({ error: 'bad_request' }, { status: 400 });
      }
      const parsed = V1GcpDiscoverBody.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ error: 'bad_request', reason: 'invalid_body' }, { status: 400 });
      }

      try {
        const conn = await prisma.gcpConnection.findFirst({
          where: { id: parsed.data.connectionId },
          select: { id: true, zones: true, userId: true },
        });
        if (!conn) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }

        // Same cross-team gap as AWS/Azure v1 — documented.
        const zones = parsed.data.zones ?? conn.zones;
        const dispatched = await dispatchDiscoveryRun({
          provider: 'gcp',
          connectionId: conn.id,
          userId: conn.userId,
          regions: zones,
        });
        const item = GcpDiscoveryCreateResponse.parse({
          id: dispatched.runId,
          status: GcpRunStatus.enum.queued,
          pollUrl: dispatched.pollUrl,
        });
        return NextResponse.json(V1GcpDiscoverResponse.parse(item), { status: 201 });
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}
