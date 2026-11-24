// @polsia:user-owned — GET /api/cloud/runs/[id]. Cross-provider run probe
// against the (aws|azure|gcp)DiscoveryRun tables. Owner-scoped — every
// Prisma query filters on userId + id. Returns the run + per-provider
// asset list + finding count, with `provider` discriminator so the client
// island can pick the right `<Aws|Azure|Gcp>RunStatus>` view.

import 'server-only';
import { NextResponse } from 'next/server';
import { AwsAssetItem, AwsDiscoveryRunWithAssets } from '@/lib/contracts/aws';
import { AzureAssetItem, AzureDiscoveryRunWithAssets } from '@/lib/contracts/azure';
import { CloudRunDetails } from '@/lib/contracts/cloud-discover';
import { GcpAssetItem, GcpDiscoveryRunWithAssets } from '@/lib/contracts/gcp';
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

  // Three cheapest Prisma findUnique queries — all PK lookups. The route
  // tries AWS first (highest traffic), then Azure, then GCP. Only ONE
  // returns a row; the others return null.
  const aws = await prisma.awsDiscoveryRun.findFirst({
    where: { id, userId: user.id },
    include: { assets: { take: 200 }, findings: true },
  });
  if (aws) {
    return NextResponse.json(
      CloudRunDetails.parse({
        provider: 'aws',
        run: AwsDiscoveryRunWithAssets.parse({
          id: aws.id,
          connectionId: aws.connectionId,
          status: aws.status,
          startedAt: aws.startedAt.toISOString(),
          finishedAt: aws.finishedAt ? aws.finishedAt.toISOString() : null,
          errorMessage: aws.errorMessage,
          accountId: aws.accountId,
          regions: aws.regions,
          resourcesTotal: aws.resourcesTotal,
          assets: aws.assets.map((a) =>
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
        }),
        findings: aws.findings.length,
      }),
    );
  }

  const azure = await prisma.azureDiscoveryRun.findFirst({
    where: { id, userId: user.id },
    include: { assets: { take: 200 }, findings: true },
  });
  if (azure) {
    return NextResponse.json(
      CloudRunDetails.parse({
        provider: 'azure',
        run: AzureDiscoveryRunWithAssets.parse({
          id: azure.id,
          connectionId: azure.connectionId,
          status: azure.status,
          startedAt: azure.startedAt.toISOString(),
          finishedAt: azure.finishedAt ? azure.finishedAt.toISOString() : null,
          errorMessage: azure.errorMessage,
          subscriptionId: azure.subscriptionId,
          locations: azure.locations,
          resourcesTotal: azure.resourcesTotal,
          assets: azure.assets.map((a) =>
            AzureAssetItem.parse({
              id: a.id,
              runId: a.runId,
              subscriptionId: a.subscriptionId,
              location: a.location,
              resourceType: a.resourceType,
              resourceArn: a.resourceArn,
              resourceId: a.resourceId,
              publicExposure: a.publicExposure,
              serviceHint: a.serviceHint,
            }),
          ),
        }),
        findings: azure.findings.length,
      }),
    );
  }

  const gcp = await prisma.gcpDiscoveryRun.findFirst({
    where: { id, userId: user.id },
    include: { assets: { take: 200 }, findings: true },
  });
  if (gcp) {
    return NextResponse.json(
      CloudRunDetails.parse({
        provider: 'gcp',
        run: GcpDiscoveryRunWithAssets.parse({
          id: gcp.id,
          connectionId: gcp.connectionId,
          status: gcp.status,
          startedAt: gcp.startedAt.toISOString(),
          finishedAt: gcp.finishedAt ? gcp.finishedAt.toISOString() : null,
          errorMessage: gcp.errorMessage,
          projectId: gcp.projectId,
          zones: gcp.zones,
          resourcesTotal: gcp.resourcesTotal,
          assets: gcp.assets.map((a) =>
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
        }),
        findings: gcp.findings.length,
      }),
    );
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
