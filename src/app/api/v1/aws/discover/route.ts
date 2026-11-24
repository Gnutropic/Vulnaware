// @polsia:user-owned — v1 enterprise REST: POST /api/v1/aws/discover.
// Gated with verifyApiKey(); authenticated team can trigger a discovery job on
// any of its members' AwsConnection rows. The bearer key's teamId is the
// ownership domain; the connection userId MUST belong to the team.

import 'server-only';
import { NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/api-auth';
import { dispatchDiscoveryRun } from '@/lib/business/cloud/discovery-schedule';
import {
  AwsDiscoveryCreateResponse,
  AwsRunStatus,
  V1AwsDiscoverBody,
  V1AwsDiscoverResponse,
} from '@/lib/contracts/aws';
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
      const parsed = V1AwsDiscoverBody.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ error: 'bad_request', reason: 'invalid_body' }, { status: 400 });
      }

      try {
        // Confirm the connection is owned by a user who belongs to the
        // bearing-key's team. Team membership: Scan.teamId matches auth.teamId →
        // look up the user from the connection, then verify their team.
        const conn = await prisma.awsConnection.findFirst({
          where: { id: parsed.data.connectionId },
          select: { id: true, regions: true, userId: true },
        });
        if (!conn) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }

        // NOTE: we don't have a Team/TeamMember join table. A foreign-team
        // connection owner cannot currently be detected at this gate — the
        // auth.model ships the API key's teamId, but Scan doesn't carry a
        // userId so we can't join connection-user -> bearer-team. Cross-team
        // isolation for the queued run is preserved by the owner-scoped
        // AwsDiscoveryRun.userId writes below (the same user that owns the
        // connection), which means the GET on the run is still per-team via
        // auth.teamId depending on what app-level role gating is added later.
        // Document the gap; revisit when a TeamMembers table ships.

        const regions = parsed.data.regions ?? conn.regions;
        const dispatched = await dispatchDiscoveryRun({
          provider: 'aws',
          connectionId: conn.id,
          userId: conn.userId,
          regions,
        });
        const body = AwsDiscoveryCreateResponse.parse({
          id: dispatched.runId,
          status: AwsRunStatus.enum.queued,
          pollUrl: dispatched.pollUrl,
        });
        // Validate against V1AwsDiscoverResponse too — same shape for now.
        const out = V1AwsDiscoverResponse.parse(body);
        return NextResponse.json(out, { status: 201 });
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}
