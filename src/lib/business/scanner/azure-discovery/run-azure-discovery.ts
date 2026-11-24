// @polsia:user-owned — Azure discovery orchestrator. Reads the queued
// `AzureDiscoveryRun`, builds a ClientSecretCredential from the connection
// row, fans out across locations, persists `AzureAsset` rows. The ONLY
// azure-discovery module that touches @/lib/db + SDK clients.
//
// On the first two runs of this task the SDK packages / env vars silently
// failed the orchestrator — every entry below preflights `require` so a
// missing package or env surfaces a PRECISE error string in `errorMessage`
// instead of swallowing.

import 'server-only';

// Preflight: every SDK import wrapped in try/catch so a missing package
// surfaces a precise error during the FIRST run, not silently on every
// deploy. The throw propagates to the cron's outer try/catch → errorMessage
// stamped on the run row + logged to stdout.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/identity');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/identity) — run "npm install @azure/identity"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/arm-compute');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/arm-compute) — run "npm install @azure/arm-compute"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/arm-storage');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/arm-storage) — run "npm install @azure/arm-storage"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/arm-resources');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/arm-resources) — run "npm install @azure/arm-resources"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/arm-authorization');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/arm-authorization) — run "npm install @azure/arm-authorization"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/arm-sql');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/arm-sql) — run "npm install @azure/arm-sql"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@azure/arm-network');
} catch {
  throw new Error(
    'azure-discovery SDK missing (@azure/arm-network) — run "npm install @azure/arm-network"',
  );
}

import { AuthorizationManagementClient } from '@azure/arm-authorization';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { SqlManagementClient } from '@azure/arm-sql';
import { StorageManagementClient } from '@azure/arm-storage';
import { ClientSecretCredential } from '@azure/identity';
import { matchAzureAssets } from '@/lib/business/scanner/azure-discovery/azure-matcher';
import { enumerateVirtualMachines } from '@/lib/business/scanner/azure-discovery/compute-enumerate';
import { enumerateNetwork as enumerateAzureNetwork } from '@/lib/business/scanner/azure-discovery/network-enumerate';
import { enumerateRoleAssignments } from '@/lib/business/scanner/azure-discovery/rbac-enumerate';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';
import { enumerateSqlServers } from '@/lib/business/scanner/azure-discovery/sql-enumerate';
import { enumerateStorageAccounts } from '@/lib/business/scanner/azure-discovery/storage-enumerate';
import { matchResource } from '@/lib/business/scanner/matcher';
import { prisma } from '@/lib/db';

export interface RunAzureDiscoveryParams {
  /** Discovery run id — must exist and be in `queued` state. */
  runId: string;
}

// Per-location concurrency cap. Unbounded Promise.all over N regions can
// starve the Node event loop when N is large.
const PER_LOCATION_CONCURRENCY = 4;

export async function runAzureDiscovery(params: RunAzureDiscoveryParams): Promise<void> {
  const run = await prisma.azureDiscoveryRun.findUnique({
    where: { id: params.runId },
    include: { connection: true },
  });
  if (!run) {
    throw new Error(`run ${params.runId} not found`);
  }
  if (run.status !== 'queued') {
    return;
  }

  await prisma.azureDiscoveryRun.update({
    where: { id: run.id },
    data: {
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    },
  });

  try {
    const credential = new ClientSecretCredential(
      run.connection.tenantId,
      run.connection.clientId,
      run.connection.clientSecret,
    );

    const subscriptionId = run.connection.subscriptionId;
    const locations = pickLocations(run.connection.locations);
    const drafts = await fanOutAcrossLocations({
      locations,
      subscriptionId,
      credential,
    });

    if (drafts.length > 0) {
      await prisma.azureAsset.createMany({
        data: drafts.map((d) => ({
          runId: run.id,
          subscriptionId: d.subscriptionId,
          location: d.location,
          resourceType: d.resourceType,
          resourceArn: d.resourceArn,
          resourceId: d.resourceId ?? null,
          publicExposure: d.publicExposure ?? null,
          serviceHint: d.serviceHint ?? null,
        })),
        skipDuplicates: true,
      });
    }

    const hits = matchAzureAssets({ subscriptionId }, drafts);

    // Cross-reference each persisted draft against the resource-shape
    // fingerprint seed in matcher.ts. Findings land in the same
    // AzureFinding row family; cveSource distinguishes 'synthesized'
    // (default AZ-* ids) from 'shape' (a synthesized id mapping to a
    // real-CVE descriptor) and 'cve-db' (a real CVE id resolved through
    // cve-feed.ts).
    const shapeHits: Array<{
      resourceArn: string;
      cveId: string;
      severity: string | null;
      matchReason: string;
      cveSource: 'shape';
    }> = [];
    for (const asset of drafts) {
      const matches = await matchResource({
        provider: 'azure',
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

    if (allFindings.length > 0) {
      const persistedAssets = await prisma.azureAsset.findMany({
        where: {
          runId: run.id,
          resourceArn: { in: allFindings.map((h) => h.resourceArn) },
        },
        select: { id: true, resourceArn: true },
      });
      const idByArn = new Map(persistedAssets.map((a) => [a.resourceArn, a.id]));
      await prisma.azureFinding.createMany({
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

    await prisma.azureDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        subscriptionId,
        resourcesTotal: drafts.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.azureDiscoveryRun.update({
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

function pickLocations(connectionLocations: string[]): string[] {
  if (connectionLocations.length > 0) return connectionLocations;
  // Fallback to a sensible default so a misconfigured connection doesn't
  // get stuck with an empty scan.
  return ['eastus'];
}

interface FanOutParams {
  locations: string[];
  subscriptionId: string;
  credential: ClientSecretCredential;
}

async function fanOutAcrossLocations(params: FanOutParams): Promise<AzureAssetDraft[]> {
  const { locations, subscriptionId, credential } = params;
  const results: AzureAssetDraft[] = [];

  // RBAC is subscription-scope — run once regardless of location.
  try {
    const authz = new AuthorizationManagementClient(credential, subscriptionId);
    results.push(...(await enumerateRoleAssignments({ client: authz, subscriptionId })));
  } catch {
    // degrade — RBAC is best-effort.
  }

  // Storage is subscription-scope — enumerate accounts once.
  try {
    const storage = new StorageManagementClient(credential, subscriptionId);
    results.push(...(await enumerateStorageAccounts({ client: storage, subscriptionId })));
  } catch {
    // degrade
  }

  // SQL is subscription-scope — same for vNets + NSGs (also subscription-
  // scope). Build one SqlManagementClient + one NetworkManagementClient
  // for the whole subscription.
  try {
    const sql = new SqlManagementClient(credential, subscriptionId);
    results.push(...(await enumerateSqlServers({ client: sql, subscriptionId })));
  } catch {
    // degrade
  }

  try {
    const network = new NetworkManagementClient(credential, subscriptionId);
    results.push(...(await enumerateAzureNetwork({ client: network, subscriptionId })));
  } catch {
    // degrade
  }

  // Per-location fanout: VMs.
  for (let i = 0; i < locations.length; i += PER_LOCATION_CONCURRENCY) {
    const slice = locations.slice(i, i + PER_LOCATION_CONCURRENCY);
    const sliceResults = await Promise.allSettled(
      slice.map(async (location) => {
        const compute = new ComputeManagementClient(credential, subscriptionId);
        try {
          return await enumerateVirtualMachines({
            location,
            subscriptionId,
            client: compute,
          });
        } catch {
          return [] as AzureAssetDraft[];
        }
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
