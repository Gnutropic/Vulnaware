// @polsia:user-owned — GET /api/trial-progress.
//
// Auth-gated. Returns the four onboarding-step counters the
// OnboardingStepper drives. Server resolves the caller's team from
// the session; the stepper never sends teamId from the client.
//
// CloudConnection models carry `userId` (scalar; User is locked in
// auth.prisma, no Prisma @relation). We therefore aggregate counts over
// every team's userIds via the membership roster.

import 'server-only';
import { NextResponse } from 'next/server';
import { trialProgressResponse } from '@/lib/contracts/trial';
import { prisma } from '@/lib/db';
import { withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let user: SessionUser;
      try {
        user = await requireAuth(req);
      } catch (res) {
        return res as Response;
      }

      const membership = await prisma.membership.findUnique({
        where: { userId: user.id },
        select: { teamId: true },
      });
      if (!membership) {
        const empty = trialProgressResponse.parse({
          scansCreated: 0,
          apiKeysIssued: 0,
          cloudConnectionsConnected: 0,
          teammatesInvited: 0,
        });
        return NextResponse.json(empty);
      }
      const teamId = membership.teamId;

      try {
        const roster = await prisma.membership.findMany({
          where: { teamId },
          select: { userId: true },
        });
        const userIds = roster.map((r) => r.userId);

        const [scansCreated, apiKeysIssued, awsCount, azureCount, gcpCount] = await Promise.all([
          prisma.scan.count({ where: { teamId } }),
          prisma.apiKey.count({ where: { teamId, revokedAt: null } }),
          prisma.awsConnection.count({ where: { userId: { in: userIds } } }),
          prisma.azureConnection.count({ where: { userId: { in: userIds } } }),
          prisma.gcpConnection.count({ where: { userId: { in: userIds } } }),
        ]);

        const out = trialProgressResponse.parse({
          scansCreated,
          apiKeysIssued,
          cloudConnectionsConnected: awsCount + azureCount + gcpCount,
          teammatesInvited: Math.max(0, roster.length - 1),
        });
        return NextResponse.json(out);
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
