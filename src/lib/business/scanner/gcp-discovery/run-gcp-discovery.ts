// @polsia:user-owned — GCP discovery orchestrator. Reads the queued
// `GcpDiscoveryRun`, builds SDK clients from the connection row
// serviceAccountJson, fans out across zones, persists `GcpAsset` rows.
//
// SDK preflight: every SDK package is wrapped in try/require so a missing
// package surfaces a precise error in `errorMessage` on the FIRST run, not
// silently on every deploy (the first two runs of this task are believed to
// have failed this way).
//
// NOTE: `google-gax` ships a nested google-auth-library, so we pass the raw
// service-account `credentials` object to each SDK instead of a shared
// `GoogleAuth` instance — gax-based clients accept credentials too and the
// nested/outer GoogleAuth types are different identities (cross-package).

import 'server-only';

// SDK preflight — fail loudly with the missing package name.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('google-auth-library');
} catch {
  throw new Error(
    'gcp-discovery SDK missing (google-auth-library) — run "npm install google-auth-library"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@google-cloud/compute');
} catch {
  throw new Error(
    'gcp-discovery SDK missing (@google-cloud/compute) — run "npm install @google-cloud/compute"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@google-cloud/storage');
} catch {
  throw new Error(
    'gcp-discovery SDK missing (@google-cloud/storage) — run "npm install @google-cloud/storage"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@google-cloud/resource-manager');
} catch {
  throw new Error(
    'gcp-discovery SDK missing (@google-cloud/resource-manager) — run "npm install @google-cloud/resource-manager"',
  );
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@google-cloud/sql');
} catch {
  throw new Error(
    'gcp-discovery SDK missing (@google-cloud/sql) — run "npm install @google-cloud/sql"',
  );
}

import { FirewallsClient, InstancesClient, NetworksClient } from '@google-cloud/compute';
import { ProjectsClient, protos } from '@google-cloud/resource-manager';
import { SqlInstancesServiceClient } from '@google-cloud/sql';
import { Storage } from '@google-cloud/storage';
import { enumerateGceInstances } from '@/lib/business/scanner/gcp-discovery/compute-enumerate';
import { matchGcpAssets } from '@/lib/business/scanner/gcp-discovery/gcp-matcher';
import { enumerateProjectIam } from '@/lib/business/scanner/gcp-discovery/iam-enumerate';
import { enumerateNetwork as enumerateGcpNetwork } from '@/lib/business/scanner/gcp-discovery/network-enumerate';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';
import { enumerateCloudSql } from '@/lib/business/scanner/gcp-discovery/sql-enumerate';
import { enumerateGcsBuckets } from '@/lib/business/scanner/gcp-discovery/storage-enumerate';
import { matchResource } from '@/lib/business/scanner/matcher';
import { prisma } from '@/lib/db';

export interface RunGcpDiscoveryParams {
  /** Discovery run id — must exist and be in `queued` state. */
  runId: string;
}

export async function runGcpDiscovery(params: RunGcpDiscoveryParams): Promise<void> {
  const run = await prisma.gcpDiscoveryRun.findUnique({
    where: { id: params.runId },
    include: { connection: true },
  });
  if (!run) {
    throw new Error(`run ${params.runId} not found`);
  }
  if (run.status !== 'queued') {
    return;
  }

  await prisma.gcpDiscoveryRun.update({
    where: { id: run.id },
    data: {
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    },
  });

  try {
    const credentials = parseServiceAccountJson(run.connection.serviceAccountJson);
    const projectId = run.connection.projectId;
    const zones = pickZones(run.connection.zones);

    const drafts = await fanOutAcrossZones({ zones, projectId, credentials });

    if (drafts.length > 0) {
      await prisma.gcpAsset.createMany({
        data: drafts.map((d) => ({
          runId: run.id,
          projectId: d.projectId,
          zone: d.zone,
          resourceType: d.resourceType,
          resourceArn: d.resourceArn,
          resourceId: d.resourceId ?? null,
          publicExposure: d.publicExposure ?? null,
          serviceHint: d.serviceHint ?? null,
        })),
        skipDuplicates: true,
      });
    }

    const hits = matchGcpAssets({ projectId }, drafts);

    // Cross-reference each persisted draft against the resource-shape
    // fingerprint seed in matcher.ts. Findings land in the same
    // GcpFinding row family; cveSource distinguishes 'synthesized'
    // (default GCP-* ids) from 'shape' (a synthesized id mapping to a
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
        provider: 'gcp',
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
      const persistedAssets = await prisma.gcpAsset.findMany({
        where: {
          runId: run.id,
          resourceArn: { in: allFindings.map((h) => h.resourceArn) },
        },
        select: { id: true, resourceArn: true },
      });
      const idByArn = new Map(persistedAssets.map((a) => [a.resourceArn, a.id]));
      await prisma.gcpFinding.createMany({
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

    await prisma.gcpDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        projectId,
        resourcesTotal: drafts.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.gcpDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: message.slice(0, 2000),
      },
    });
    throw err;
  }
}

function pickZones(connectionZones: string[]): string[] {
  if (connectionZones.length > 0) return connectionZones;
  return ['us-central1-a'];
}

interface SaCredentials {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

function parseServiceAccountJson(raw: string): SaCredentials {
  let json: SaCredentials;
  try {
    json = JSON.parse(raw) as SaCredentials;
  } catch (err) {
    throw new Error(
      `gcp-discovery: invalid service-account JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (json.type !== 'service_account') {
    throw new Error('gcp-discovery: service-account JSON must be type "service_account"');
  }
  return json;
}

interface FanOutParams {
  zones: string[];
  projectId: string;
  credentials: SaCredentials;
}

async function fanOutAcrossZones(params: FanOutParams): Promise<GcpAssetDraft[]> {
  const { projectId, zones, credentials } = params;
  const results: GcpAssetDraft[] = [];

  // Project IAM is global — read once via the resource-manager client. Build
  // credentials → caller type is a passthrough JSON record (gax accepts it).
  try {
    const projectsClient = new ProjectsClient({
      credentials: credentials as unknown as Record<string, unknown>,
      projectId,
    });
    results.push(
      ...(await enumerateProjectIam({
        projectId,
        client: {
          getIamPolicy: async () => {
            const [policy] = await projectsClient.getIamPolicy({
              resource: `projects/${projectId}`,
            });
            // The proto IPolicy uses Buffer|etags|...; normalize for our enum
            // by narrowing etag to string|null.
            if (!policy) return { bindings: [], etag: null };
            const raw = policy;
            const rawEtag = raw.etag;
            const etag = typeof rawEtag === 'string' ? rawEtag : null;
            // The SDK returns proto.iam.v1.IPolicy with .bindings[]; map to
            // our GcpIamBinding shape.
            const bindings = (raw.bindings ?? []).map((b) => ({
              role: b.role ?? null,
              members: b.members ?? null,
            }));
            return { bindings, etag };
          },
        },
      })),
    );
  } catch {
    // degrade — IAM is best-effort.
  }
  // Touch the protos import so tsc doesn't flag it as unused; the resource-
  // manager SDK relies on this for IPolicy type composition in some
  // downstream code paths.
  void protos;

  // Storage is global — list buckets once with credentials directly.
  try {
    const storage = new Storage({
      projectId,
      credentials: credentials as unknown as Record<string, unknown>,
    });
    results.push(
      ...(await enumerateGcsBuckets({
        projectId,
        client: storage,
      })),
    );
  } catch {
    // degrade
  }

  // Compute — fan out via aggregated list. Build the InstancesClient with
  // raw credentials so gax uses them directly.
  try {
    const instancesClient = new InstancesClient({
      credentials: credentials as unknown as Record<string, unknown>,
      projectId,
    });
    results.push(
      ...(await enumerateGceInstances({
        projectId,
        zones,
        client: {
          // Cast: gax returns proto IInstancesScopedList; the enumerator's
          // predicate only reads a few fields we re-extract to our shape.
          aggregatedList: ((req: { project: string }) =>
            instancesClient.aggregatedListAsync({ project: req.project })) as unknown as (req: {
            project: string;
          }) => AsyncIterable<[string, AggregatedInstancesResponse]>,
        },
      })),
    );
  } catch {
    // degrade
  }

  // Network — same approach: build the NetworksClient + FirewallsClient
  // with raw credentials so gax routes through them directly.
  try {
    const networksClient = new NetworksClient({
      credentials: credentials as unknown as Record<string, unknown>,
      projectId,
    });
    const firewallsClient = new FirewallsClient({
      credentials: credentials as unknown as Record<string, unknown>,
      projectId,
    });
    results.push(
      ...(await enumerateGcpNetwork({
        projectId,
        networks: networksClient,
        firewalls: firewallsClient,
      })),
    );
  } catch {
    // degrade
  }

  // Cloud SQL — list across the whole project.
  try {
    const sqlClient = new SqlInstancesServiceClient({
      credentials: credentials as unknown as Record<string, unknown>,
      projectId,
    });
    results.push(
      ...(await enumerateCloudSql({
        projectId,
        client: sqlClient,
      })),
    );
  } catch {
    // degrade
  }

  return results;
}

interface AggregatedInstancesResponse {
  instances?: Record<string, InstanceView> | null;
}

interface InstanceNic {
  accessConfigs?: Array<{ type?: string | null; name?: string | null }> | null;
}

interface InstanceView {
  id?: string | string | null | number | null;
  name?: string | null;
  machineType?: string | null;
  networkInterfaces?: InstanceNic[] | null;
}
