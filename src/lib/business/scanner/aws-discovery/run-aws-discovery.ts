// @polsia:user-owned — Top-level AWS discovery orchestrator. Reads the queued
// `AwsDiscoveryRun`, assumes the role via STS, fans out across regions (and
// across the enumerators), persists `AwsAsset` rows. The ONLY AWS-discovery
// module that touches @/lib/db — every other module in this folder is pure.

import 'server-only';

// SDK preflight — fail loudly with the missing package name. Mirror of the
// Azure orchestrator's preflight pattern so a missing dep surfaces a
// precise string in `errorMessage` on the FIRST run rather than failing
// every deploy silently.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@aws-sdk/client-rds');
} catch {
  throw new Error(
    'aws-discovery SDK missing (@aws-sdk/client-rds) — run "npm install @aws-sdk/client-rds"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@aws-sdk/client-dynamodb');
} catch {
  throw new Error(
    'aws-discovery SDK missing (@aws-sdk/client-dynamodb) — run "npm install @aws-sdk/client-dynamodb"',
  );
}

import { ConfigServiceClient } from '@aws-sdk/client-config-service';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { RDSClient } from '@aws-sdk/client-rds';
import { ResourceExplorer2Client } from '@aws-sdk/client-resource-explorer-2';
import { S3Client } from '@aws-sdk/client-s3';
import { matchAwsAssets } from '@/lib/business/scanner/aws-discovery/aws-matcher';
import { enumerateConfigRules } from '@/lib/business/scanner/aws-discovery/config-rules';
import {
  enumerateDynamoDbTables,
  enumerateRds,
} from '@/lib/business/scanner/aws-discovery/data-enumerate';
import { enumerateInstances as enumerateEc2 } from '@/lib/business/scanner/aws-discovery/ec2-enumerate';
import { enumerateIam } from '@/lib/business/scanner/aws-discovery/iam-enumerate';
import { enumerateNetwork } from '@/lib/business/scanner/aws-discovery/network-enumerate';
import { enumerateViaResourceExplorer } from '@/lib/business/scanner/aws-discovery/resource-explorer';
import { enumerateBuckets as enumerateS3 } from '@/lib/business/scanner/aws-discovery/s3-enumerate';
import { type AwsAssetDraft, credentialsFrom } from '@/lib/business/scanner/aws-discovery/shared';
import {
  type AssumedRoleCredentials,
  assumeRole,
} from '@/lib/business/scanner/aws-discovery/sts-assume';
import { matchResource } from '@/lib/business/scanner/matcher';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export interface RunAwsDiscoveryParams {
  /** Discovery run id — must exist and be in `queued` state. */
  runId: string;
}

// Per-region concurrency cap. AWS SDKs are cooperative but unbounded
// Promise.all over N regions can starve the Node event loop when N is large.
const PER_REGION_CONCURRENCY = 4;

export async function runAwsDiscovery(params: RunAwsDiscoveryParams): Promise<void> {
  const run = await prisma.awsDiscoveryRun.findUnique({
    where: { id: params.runId },
    include: { connection: true },
  });
  if (!run) {
    throw new Error(`run ${params.runId} not found`);
  }
  if (run.status !== 'queued') {
    return;
  }

  await prisma.awsDiscoveryRun.update({
    where: { id: run.id },
    data: {
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    },
  });

  try {
    const credentials = await assumeRole({
      roleArn: run.connection.roleArn,
      externalId: run.connection.externalId,
      region: env.AWS_REGION,
    });

    const accountIdFromAssumedRole =
      credentials.accountId ?? extractAccountFromArn(run.connection.roleArn);
    const regions = pickRegions(run.connection.regions);
    const drafts = await fanOutAcrossRegions({
      regions,
      credentials,
      accountId: accountIdFromAssumedRole ?? run.connection.userId,
    });

    // Persist assets. createMany skips dupes on the @unique index
    // (runId, resourceArn) so already-present rows from a partial run don't
    // blow up. Drafts MAY include synthesized roll-up ARNs (config:compliance)
    // — the @unique enforces idempotent writes per run.
    if (drafts.length > 0) {
      await prisma.awsAsset.createMany({
        data: drafts.map((d) => ({
          runId: run.id,
          accountId: d.accountId,
          region: d.region,
          resourceType: d.resourceType,
          resourceArn: d.resourceArn,
          resourceId: d.resourceId ?? null,
          publicExposure: d.publicExposure ?? null,
          serviceHint: d.serviceHint ?? null,
        })),
        skipDuplicates: true,
      });
    }

    const accountId = accountIdFromAssumedRole ?? run.connection.userId;
    const hits = matchAwsAssets({ accountId }, drafts);

    // matchResource() also cross-references each persisted draft against
    // the resource-shape fingerprint seed (RESOURCE_SEED in matcher.ts).
    // Findings land in the same AwsFinding row family but cveSource
    // distinguishes 'synthesized' from 'shape' (a synthesized id mapping
    // to a real-CVE descriptor) and 'cve-db' (a real CVE id resolved
    // through cve-feed.ts).
    const shapeHits: Array<{
      resourceArn: string;
      cveId: string;
      severity: string | null;
      matchReason: string;
      cveSource: 'shape';
    }> = [];
    for (const asset of drafts) {
      const matches = await matchResource({
        provider: 'aws',
        resourceType: asset.resourceType,
        publicExposure: asset.publicExposure ?? 'unknown',
        serviceHint: asset.serviceHint ?? null,
      });
      for (const m of matches) {
        shapeHits.push({
          resourceArn: asset.resourceArn,
          cveId: m.cveId,
          severity: m.severity,
          matchReason: m.matchReason,
          cveSource: 'shape',
        });
      }
    }

    const synthesizedHits = hits.map((h) => ({
      resourceArn: h.resourceArn,
      cveId: h.cveId,
      severity: h.severity,
      matchReason: h.matchReason,
      cveSource: h.source,
    }));
    const allFindings = [...synthesizedHits, ...shapeHits];

    // Mirror findings into the AwsFinding sibling table so the existing
    // scan UI can render them via the runs view. Synthesized cveId values
    // like 'AWS-S3-PUBLIC-001' are valid Strings but not real CVE entries
    // — AwsFinding is its own model so the FK chain isn't faked.
    if (allFindings.length > 0) {
      const persistedAssets = await prisma.awsAsset.findMany({
        where: {
          runId: run.id,
          resourceArn: { in: allFindings.map((h) => h.resourceArn) },
        },
        select: { id: true, resourceArn: true },
      });
      const idByArn = new Map(persistedAssets.map((a) => [a.resourceArn, a.id]));
      await prisma.awsFinding.createMany({
        data: allFindings.flatMap((h) => {
          const assetId = idByArn.get(h.resourceArn);
          if (!assetId) return [];
          return [
            {
              runId: run.id,
              assetId,
              cveId: h.cveId,
              cveSource: h.cveSource,
              severity: h.severity,
              matchReason: h.matchReason,
            },
          ];
        }),
      });
    }

    await prisma.awsDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        accountId: accountIdFromAssumedRole ?? null,
        resourcesTotal: drafts.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.awsDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: message.slice(0, 2000),
      },
    });
    // Re-throw so the cron logs the failure; the row already records it.
    throw err;
  }
}

function pickRegions(connectionRegions: string[]): string[] {
  if (connectionRegions.length > 0) return connectionRegions;
  // Fallback to a small set so a misconfigured connection still discovers
  // SOMETHING. The platform's default region is already validated in env.
  return [env.AWS_REGION, 'us-east-1'];
}

function extractAccountFromArn(arn: string): string | null {
  const m = /^arn:(aws[a-z-]*)?:iam::(\d{12}):role\/.+$/u.exec(arn);
  return m?.[2] ?? null;
}

interface FanOutParams {
  regions: string[];
  credentials: AssumedRoleCredentials;
  accountId: string;
}

async function fanOutAcrossRegions(params: FanOutParams): Promise<AwsAssetDraft[]> {
  const { regions, credentials, accountId } = params;
  const results: AwsAssetDraft[] = [];

  // IAM is a global service — run once across the whole account (not per-
  // region). We use the assumed role from any region; STS returns temporary
  // credentials keyed to the account, not the region.
  try {
    const iam = new IAMClient({
      region: env.AWS_REGION,
      credentials: credentialsFrom(credentials),
    });
    results.push(...(await enumerateIam({ client: iam, accountId })));
  } catch {
    // degrade — IAM is best-effort.
  }

  // Per-region fanout: EC2, S3 (also global, but we cycle through the
  // regional clients; SDK routes ListBuckets globally regardless), Config,
  // and Resource Explorer. Resource Explorer is region-bound; the SDK
  // returns whatever the index for the assumed role in that region holds.
  // RDS + DynamoDB + network (VPC / subnet / SG) enumeration are per-
  // region as well; we run them in the same slice window.
  for (let i = 0; i < regions.length; i += PER_REGION_CONCURRENCY) {
    const slice = regions.slice(i, i + PER_REGION_CONCURRENCY);
    const sliceResults = await Promise.allSettled(
      slice.map(async (region) => {
        const ec2 = new EC2Client({ region, credentials: credentialsFrom(credentials) });
        const s3 = new S3Client({ region, credentials: credentialsFrom(credentials) });
        const config = new ConfigServiceClient({
          region,
          credentials: credentialsFrom(credentials),
        });
        const re = new ResourceExplorer2Client({
          region,
          credentials: credentialsFrom(credentials),
        });
        const rds = new RDSClient({ region, credentials: credentialsFrom(credentials) });
        const dynamodb = new DynamoDBClient({
          region,
          credentials: credentialsFrom(credentials),
        });

        // Each enumerator fails independently and we swallow — a partial
        // discovery is better than a hard fail across one region.
        const out: AwsAssetDraft[] = [];
        try {
          out.push(...(await enumerateEc2({ region, accountId, client: ec2 })));
        } catch {
          // degrade
        }
        try {
          out.push(...(await enumerateS3({ client: s3, ownerAccount: accountId })));
        } catch {
          // degrade
        }
        try {
          out.push(...(await enumerateConfigRules({ client: config, region, accountId })));
        } catch {
          // degrade
        }
        try {
          out.push(...(await enumerateViaResourceExplorer({ client: re })));
        } catch {
          // degrade (Resource Explorer is optional — most accounts lack it)
        }
        try {
          out.push(...(await enumerateRds({ client: rds, region, accountId })));
        } catch {
          // degrade
        }
        try {
          out.push(...(await enumerateDynamoDbTables({ client: dynamodb, region, accountId })));
        } catch {
          // degrade
        }
        try {
          out.push(...(await enumerateNetwork({ client: ec2, region, accountId })));
        } catch {
          // degrade
        }
        return out;
      }),
    );
    for (const r of sliceResults) {
      if (r.status === 'fulfilled') {
        results.push(...r.value);
      }
    }
  }
  return results;
}
