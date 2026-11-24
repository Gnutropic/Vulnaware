// @polsia:user-owned — operator-facing feed of recent webhook trigger
// receipts. Read-only listing of the latest 20 WebhookTrigger rows for the
// caller's team, scoped by teamId, projected to the manager-safe schema.
//
// IMPORTANT — redaction posture: the WebhookTrigger row in
// prisma/schema/webhook-trigger.prisma carries a `webhookId` and is associated
// with a Webhook row whose `signingSecretCipher` is the envelope-encrypted
// signing secret. We deliberately `select` an explicit column whitelist on
// BOTH WebhookTrigger AND the related Scan rather than `include`-ing any
// relation that could leak ciphertext. Defence-in-depth:
//   1. explicit `select` whitelist on WebhookTrigger (no `include`),
//   2. nested `scan: { select: { id, status } }` (no signing material),
//   3. every row is then mapped through `toItem` which projects only the
//      intended columns.
//   4. final envelope is `.parse()`-validated through `WebhookTriggerList`,
//      which declares `.strict()` so any unknown/wrongly-leaked field fails
//      parse before reaching the client.
//
// Mirrors src/app/api/v1/webhooks/route.ts for auth + team-resolution +
// audit posture (helpers are local copies because they are intentionally
// not exported).

import 'server-only';
import { NextResponse } from 'next/server';
import { WebhookTriggerList } from '@/lib/contracts/webhooks-triggers';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function getUserTeamName(user: SessionUser): string {
  if (user.role !== 'admin') return 'users';
  return 'system';
}

async function getOrCreateTeamForUser(user: SessionUser): Promise<string> {
  const name = getUserTeamName(user);
  const team = await prisma.team.upsert({
    where: { name },
    update: {},
    create: { name },
  });
  return team.id;
}

async function requireAdminJson(req: Request): Promise<SessionUser | NextResponse> {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as NextResponse;
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return user;
}

// Whitelist projection — even though the `select` clause on the prisma call
// already filters, map through a hand-rolled function so the wire shape is
// provably controlled and any accidental future column addition cannot
// mistakenly flow into the response body.
function toItem(row: {
  id: string;
  scanId: string;
  receivedAt: Date;
  repositoryUrl: string;
  repositoryRef: string | null;
  repositoryCommit: string | null;
  buildId: string | null;
  buildStatus: string | null;
  buildBranch: string | null;
  signatureAlgorithm: string;
  scan: { id: string; status: string };
}): {
  id: string;
  scanId: string;
  receivedAt: string;
  repositoryUrl: string;
  repositoryRef: string | null;
  repositoryCommit: string | null;
  buildId: string | null;
  buildStatus: string | null;
  buildBranch: string | null;
  signatureAlgorithm: 'hmac-sha256';
  status: 'queued' | 'running' | 'completed' | 'failed';
} {
  return {
    id: row.id,
    scanId: row.scanId,
    receivedAt: row.receivedAt.toISOString(),
    repositoryUrl: row.repositoryUrl,
    repositoryRef: row.repositoryRef ?? null,
    repositoryCommit: row.repositoryCommit ?? null,
    buildId: row.buildId ?? null,
    buildStatus: row.buildStatus ?? null,
    buildBranch: row.buildBranch ?? null,
    signatureAlgorithm: 'hmac-sha256',
    status: row.scan.status as 'queued' | 'running' | 'completed' | 'failed',
  };
}

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const authResult = await requireAdminJson(req);
      if (authResult instanceof NextResponse) return authResult;

      setRequestAuth({ userId: authResult.id, teamId: 'unresolved' });

      const teamId = await getOrCreateTeamForUser(authResult);
      setRequestAuth({ teamId });

      try {
        const rows = await prisma.webhookTrigger.findMany({
          where: { teamId },
          orderBy: { receivedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            scanId: true,
            receivedAt: true,
            repositoryUrl: true,
            repositoryRef: true,
            repositoryCommit: true,
            buildId: true,
            buildStatus: true,
            buildBranch: true,
            signatureAlgorithm: true,
            scan: { select: { id: true, status: true } },
          },
        });
        const items = WebhookTriggerList.parse({
          items: rows.map(toItem),
        });
        return NextResponse.json(items);
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
