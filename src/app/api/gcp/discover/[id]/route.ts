// @polsia:user-owned — GET /api/gcp/discover/[id]. Returns the persisted
// run + the GcpAsset rows. Owner-scoped — never leak a foreign user's
// run/asset rows.

import 'server-only';
import { NextResponse } from 'next/server';
import { GcpAssetItem, GcpDiscoveryRunItem, GcpDiscoveryRunWithAssets } from '@/lib/contracts/gcp';
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
    const run = await prisma.gcpDiscoveryRun.findFirst({
      where: { id, userId: user.id },
      include: {
        assets: { take: 200 },
      },
    });
    if (!run) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const header = GcpDiscoveryRunItem.parse({
      id: run.id,
      connectionId: run.connectionId,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      errorMessage: run.errorMessage,
      projectId: run.projectId,
      zones: run.zones,
      resourcesTotal: run.resourcesTotal,
    });

    const body = GcpDiscoveryRunWithAssets.parse({
      ...header,
      assets: run.assets.map((a) =>
        GcpAssetItem.parse({
          id: a.id,
          runId: a.runId,
          projectId: a.projectId,
          zone: a.zone,
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
