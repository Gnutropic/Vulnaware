// @polsia:user-owned — Shared dispatch entry point for cloud discovery runs.
// Both the v1 /api/v1/{aws,azure,gcp}/discover POST handlers AND the platform
// cron in jobs/cloud-discovery-run.ts funnel into `dispatchDiscoveryRun`
// so that the queue row creation lives in ONE place. Provider switches
// map directly onto the three per-cloud discovery run models in
// prisma/schema/{aws,azure,gcp}-discovery.prisma — no native Prisma union
// exists, so a per-cloud create is necessary.
//
// Field-name differences (`regions` / `locations` / `zones`) are absorbed
// at the boundary — the cron hands in the connection's pinned list, and
// v1 route handlers pass through their parsed region's `regions`/`locations`/
// `zones` input.
//
// The returned `pollUrl` matches the wire shape already produced by the v1
// routes so a client can hold the same polling contract whether the run was
// triggered manually or by the scheduled cron.

import 'server-only';
import type { CloudDiscoveryProvider } from '@/lib/contracts/cloud-discovery';
import { prisma } from '@/lib/db';

export interface DispatchDiscoveryRunParams {
  provider: CloudDiscoveryProvider;
  connectionId: string;
  userId: string;
  regions: string[];
}

export interface DispatchDiscoveryRunResult {
  runId: string;
  pollUrl: string;
}

export async function dispatchDiscoveryRun(
  params: DispatchDiscoveryRunParams,
): Promise<DispatchDiscoveryRunResult> {
  switch (params.provider) {
    case 'aws': {
      const created = await prisma.awsDiscoveryRun.create({
        data: {
          userId: params.userId,
          connectionId: params.connectionId,
          status: 'queued',
          regions: params.regions,
        },
      });
      return { runId: created.id, pollUrl: `/api/v1/aws/discover/${created.id}` };
    }
    case 'azure': {
      const created = await prisma.azureDiscoveryRun.create({
        data: {
          userId: params.userId,
          connectionId: params.connectionId,
          status: 'queued',
          locations: params.regions,
        },
      });
      return { runId: created.id, pollUrl: `/api/v1/azure/discover/${created.id}` };
    }
    case 'gcp': {
      const created = await prisma.gcpDiscoveryRun.create({
        data: {
          userId: params.userId,
          connectionId: params.connectionId,
          status: 'queued',
          zones: params.regions,
        },
      });
      return { runId: created.id, pollUrl: `/api/v1/gcp/discover/${created.id}` };
    }
  }
}
