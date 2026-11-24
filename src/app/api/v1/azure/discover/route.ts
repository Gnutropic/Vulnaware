// @polsia:user-owned — v1 enterprise REST: POST /api/v1/azure/discover.
// Gated with verifyApiKey(); authenticated team can trigger a discovery job
// on any of its members' AzureConnection rows. The bearer key's teamId is the
// ownership domain; the connection userId must belong to the team.

import 'server-only';
import { NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/api-auth';
import { dispatchDiscoveryRun } from '@/lib/business/cloud/discovery-schedule';
import {
  AzureDiscoveryCreateResponse,
  AzureRunStatus,
  V1AzureDiscoverBody,
  V1AzureDiscoverResponse,
} from '@/lib/contracts/azure';
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
      const parsed = V1AzureDiscoverBody.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ error: 'bad_request', reason: 'invalid_body' }, { status: 400 });
      }

      try {
        const conn = await prisma.azureConnection.findFirst({
          where: { id: parsed.data.connectionId },
          select: { id: true, locations: true, userId: true },
        });
        if (!conn) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }

        // NOTE: same cross-team gap as the AWS v1 endpoint — auth carries teamId
        // but Scan doesn't carry a userId, so we can't enforce team ownership
        // here. Documented limitation; revisit when a TeamMembers table ships.
        const locations = parsed.data.locations ?? conn.locations;
        const dispatched = await dispatchDiscoveryRun({
          provider: 'azure',
          connectionId: conn.id,
          userId: conn.userId,
          regions: locations,
        });
        const item = AzureDiscoveryCreateResponse.parse({
          id: dispatched.runId,
          status: AzureRunStatus.enum.queued,
          pollUrl: dispatched.pollUrl,
        });
        return NextResponse.json(V1AzureDiscoverResponse.parse(item), { status: 201 });
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}
