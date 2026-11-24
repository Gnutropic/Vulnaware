// @polsia:user-owned — GET /api/cloud/environments. Aggregates the latest
// SUCCEEDED discovery run per (userId, connectionId) across the three
// providers. Per-user `requireAuth()` scope.
//
// "Cloud Environments" is the brief's view: provider badge + connection
// label + last-scan timestamp. We loop over the three provider tables and
// merge them into a single sorted list keyed by `provider:connectionId`.
// Connections with no successful run get a sparse row (lastScanAt=null)
// so the UI can render an "empty" CTA for un-enumerated environments.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  type CloudDiscoverProvider,
  CloudEnvironmentItem,
  CloudEnvironmentsList,
} from '@/lib/contracts/cloud-discover';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  try {
    const items: CloudEnvironmentItem[] = [];

    // AWS environments.
    const awsConns = await prisma.awsConnection.findMany({
      where: { userId: user.id },
      select: { id: true, label: true },
    });
    for (const conn of awsConns) {
      items.push(
        await buildEnvironmentFor(user.id, 'aws', conn.id, conn.label, () =>
          prisma.awsDiscoveryRun.findFirst({
            where: { userId: user.id, connectionId: conn.id },
            orderBy: { finishedAt: 'desc' },
            select: { id: true, status: true, finishedAt: true, resourcesTotal: true },
          }),
        ),
      );
    }

    // Azure environments.
    const azureConns = await prisma.azureConnection.findMany({
      where: { userId: user.id },
      select: { id: true, label: true },
    });
    for (const conn of azureConns) {
      items.push(
        await buildEnvironmentFor(user.id, 'azure', conn.id, conn.label, () =>
          prisma.azureDiscoveryRun.findFirst({
            where: { userId: user.id, connectionId: conn.id },
            orderBy: { finishedAt: 'desc' },
            select: { id: true, status: true, finishedAt: true, resourcesTotal: true },
          }),
        ),
      );
    }

    // GCP environments.
    const gcpConns = await prisma.gcpConnection.findMany({
      where: { userId: user.id },
      select: { id: true, label: true },
    });
    for (const conn of gcpConns) {
      items.push(
        await buildEnvironmentFor(user.id, 'gcp', conn.id, conn.label, () =>
          prisma.gcpDiscoveryRun.findFirst({
            where: { userId: user.id, connectionId: conn.id },
            orderBy: { finishedAt: 'desc' },
            select: { id: true, status: true, finishedAt: true, resourcesTotal: true },
          }),
        ),
      );
    }

    // Sort newest first; unsynced rows (lastScanAt=null) fall to the end.
    items.sort((a, b) => {
      const aT = a.lastScanAt ? Date.parse(a.lastScanAt) : 0;
      const bT = b.lastScanAt ? Date.parse(b.lastScanAt) : 0;
      return bT - aT;
    });

    return NextResponse.json(CloudEnvironmentsList.parse({ items }));
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

interface RunSummary {
  id: string;
  status: string;
  finishedAt: Date | null;
  resourcesTotal: number;
}

async function buildEnvironmentFor(
  _userId: string,
  provider: CloudDiscoverProvider,
  connectionId: string,
  connectionLabel: string,
  fetcher: () => Promise<RunSummary | null>,
): Promise<CloudEnvironmentItem> {
  const latest = await fetcher();
  if (!latest) {
    return CloudEnvironmentItem.parse({
      provider,
      connectionId,
      connectionLabel,
      lastScanAt: null,
      status: null,
      resourceCount: 0,
      runId: null,
    });
  }
  return CloudEnvironmentItem.parse({
    provider,
    connectionId,
    connectionLabel,
    lastScanAt: latest.finishedAt ? latest.finishedAt.toISOString() : null,
    status: latest.status,
    resourceCount: latest.resourcesTotal,
    runId: latest.id,
  });
}
