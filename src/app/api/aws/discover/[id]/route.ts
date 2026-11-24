// @polsia:user-owned — GET /api/aws/discover/[id]. Returns the run status, the
// persisted AwsAsset rows + the AwsFinding rows. Owner-scoped — never leak a
// foreign user's run/asset rows.

import 'server-only';
import { NextResponse } from 'next/server';
import { AwsAssetItem, AwsDiscoveryRunItem, AwsDiscoveryRunWithAssets } from '@/lib/contracts/aws';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { id } = await ctx.params;

  try {
    const run = await prisma.awsDiscoveryRun.findFirst({
      where: { id, userId: user.id },
      include: {
        assets: { take: 200 },
      },
    });
    if (!run) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const header = AwsDiscoveryRunItem.parse({
      id: run.id,
      connectionId: run.connectionId,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      errorMessage: run.errorMessage,
      accountId: run.accountId,
      regions: run.regions,
      resourcesTotal: run.resourcesTotal,
    });

    const body = AwsDiscoveryRunWithAssets.parse({
      ...header,
      assets: run.assets.map((a) =>
        AwsAssetItem.parse({
          id: a.id,
          runId: a.runId,
          accountId: a.accountId,
          region: a.region,
          resourceType: a.resourceType,
          resourceArn: a.resourceArn,
          resourceId: a.resourceId,
          publicExposure: a.publicExposure,
          serviceHint: a.serviceHint,
        }),
      ),
    });
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
