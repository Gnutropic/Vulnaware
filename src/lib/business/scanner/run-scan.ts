// @polsia:user-owned — Orchestrator. Wraps the TCP probe, banner classify,
// CVE matcher and writes the result (Scan + Asset + VulnerabilityFinding +
// CveEntry cache) to the database. The ONLY module in business/scanner that
// touches @/lib/db — every other module is pure.

import 'server-only';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { fetchCve } from '@/lib/business/scanner/cve-feed';
import { type EpssEntry, fetchEpssBatch } from '@/lib/business/scanner/epss';
import { fetchKevCatalog, type KevEntry } from '@/lib/business/scanner/kev';
import { createMatcherContext, type MatcherHit, match } from '@/lib/business/scanner/matcher';
import {
  compareFindings,
  type PrioritizeResult,
  prioritizeFinding,
} from '@/lib/business/scanner/prioritize';
import { detectService } from '@/lib/business/scanner/service-detect';
import { type ProbeState, probe } from '@/lib/business/scanner/tcp-probe';
import {
  fetchVulncheckBatch,
  type VulncheckHit as VulncheckHitRow,
} from '@/lib/business/scanner/vulncheck';
import type {
  AssetItem,
  ScanCreate,
  ScanItem,
  VulnerabilityFindingItem,
} from '@/lib/contracts/scan';
import {
  AssetItem as AssetItemSchema,
  VulnerabilityFindingItem as FindingItemSchema,
  isPublicRoutableAddress,
  ScanItem as ScanItemSchema,
} from '@/lib/contracts/scan';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

// Aggregate 8-second budget — enough for 5 ports at 1.5s each + DNS + DB
// round-trips, but bounded so a single hung host can't block the worker.
const AGGREGATE_BUDGET_MS = 8_000;
const PER_PROBE_TIMEOUT_MS = 1_500;

interface RunScanOptions {
  /** Override the implicit env.NVD_API_KEY read — exposed for tests. */
  apiKey?: string | undefined;
  /** Owning team id — set when the call comes from a scoped CI/CD webhook
   *  (the bearer key's team id). Default undefined leaves teamId null so
   *  existing in-app scans stay ungrouped until the bootstrap backfill. */
  teamId?: string | undefined;
  /** Pre-existing Scan row id to UPDATE instead of creating a new one.
   *  Used by the CI/CD webhook trigger (POST /api/v1/webhooks/trigger)
   *  when the route has already written a `queued` row to make the
   *  handshake row visible on the Scans page immediately. When set, the
   *  runner applies the same status transitions (running → completed /
   *  failed) to that id instead of inserting a duplicate. */
  scanIdOverride?: string | undefined;
  /** Origin marker for this scan — persisted on the row so the /alerts UI can
   *  stamp a "Triggered by" badge and the dashboard can filter by origin.
   *  Callers are expected to pass an explicit value (no default) so a missed
   *  stamp surfaces in tsc rather than landing silently as 'manual'. */
  source?: import('@/lib/contracts/scan').ScanSource;
}

interface ProbeSummary {
  port: number;
  state: ProbeState;
  latencyMs: number | null;
  banner: string | null;
  serviceHint: string | null;
  assetId: string;
}

// Pending finding captured during the match phase, scored + persisted in
// the second pass once EPSS has been batch-fetched.
interface PendingFinding {
  assetId: string;
  cveId: string;
  severity: string | null;
  matchReason: string;
  cvssScore: number | null;
}

interface ScoredFinding extends PendingFinding {
  epss: EpssEntry | null;
  kev: KevEntry | null;
  vulncheck: VulncheckHitRow | null;
  priority: PrioritizeResult;
}

export class UnsafeScanTargetError extends Error {
  constructor() {
    super('Target must resolve only to a public, routable address.');
    this.name = 'UnsafeScanTargetError';
  }
}

export async function runScan(input: ScanCreate, options: RunScanOptions = {}): Promise<ScanItem> {
  const startedAt = new Date();
  const apiKey = options.apiKey ?? env.NVD_API_KEY;

  // Resolve hostname → IP (IPv6 literals round-trip through dns.lookup). The
  // contract already rejects private/loopback IPv4 + IPv6 so the lookup is
  // bounded to a public address.
  const ip = await resolveIp(input.target);
  const ipString = ip.address;
  // Persist `host` as the user-supplied target string (hostname OR IP literal)
  // — dns.lookup echoes the hostname back when given one, but the caller may
  // have passed an IP, so the source of truth is the validated input.
  const host = input.target;

  // Run all probes concurrently per-port; aggregate 8s budget caps total time.
  const probeOutcomes = await Promise.all(
    input.ports.map(
      async (port): Promise<Pick<ProbeSummary, 'port' | 'state' | 'latencyMs' | 'banner'>> => {
        const deadline = new Promise<'budget'>((resolve) => {
          setTimeout(() => resolve('budget'), AGGREGATE_BUDGET_MS).unref?.();
        });
        const winner = await Promise.race([
          // Use the address already checked by resolveIp so a second DNS
          // lookup inside the TCP client cannot rebind the target to a
          // private or reserved address.
          probe(ipString, port, PER_PROBE_TIMEOUT_MS).then((r) => ({
            kind: 'done' as const,
            result: r,
          })),
          deadline.then(() => ({ kind: 'timeout' as const })),
        ]);
        if (winner.kind === 'done') return { port, ...winner.result };
        return { port, state: 'filtered', latencyMs: null, banner: null };
      },
    ),
  );

  // Persist the parent Scan once so every Asset can FK back to it. When
  // `scanIdOverride` is set (the CI/CD webhook trigger pre-creates a
  // queued row to make the handshake row visible on the Scans page
  // immediately), UPDATE that row instead of inserting a duplicate.
  const scanRow = options.scanIdOverride
    ? await prisma.scan.update({
        where: { id: options.scanIdOverride },
        data: {
          target: input.target,
          mode: 'tcp-only',
          status: 'running',
          startedAt,
          teamId: options.teamId ?? null,
          source: options.source ?? 'manual',
        },
      })
    : await prisma.scan.create({
        data: {
          target: input.target,
          mode: 'tcp-only',
          status: 'running',
          startedAt,
          teamId: options.teamId ?? null,
          source: options.source ?? 'manual',
        },
      });
  const createdScanId = scanRow.id;

  const summaries: ProbeSummary[] = [];

  for (const probeResult of probeOutcomes) {
    const { port, state, latencyMs, banner } = probeResult;
    const service = detectService(port, banner);
    const persistedBanner = service.banner ? service.banner.slice(0, 500) : null;

    const createdAsset = await prisma.asset.create({
      data: {
        scanId: createdScanId,
        host,
        ip: ipString,
        port,
        protocol: 'tcp',
        state,
        latencyMs,
        serviceHint: service.serviceHint,
        banner: persistedBanner,
      },
    });

    summaries.push({
      port,
      state,
      latencyMs,
      banner,
      serviceHint: service.serviceHint,
      assetId: createdAsset.id,
    });
  }

  // Each asset is an independent vulnerability check. Start them together,
  // then flatten in probe order so completion timing cannot change the result
  // order when two checks find equally-ranked vulnerabilities.
  const matcherContext = createMatcherContext();
  const matchesByAsset = await Promise.all(
    summaries.map(async (summary): Promise<MatcherHit[]> => {
      try {
        return await match(
          {
            host,
            port: summary.port,
            serviceHint: summary.serviceHint,
            banner: summary.banner,
          },
          matcherContext,
        );
      } catch {
        // A failed individual check must not discard findings from other ports.
        return [];
      }
    }),
  );
  const matchedRows = summaries.flatMap((summary, index) =>
    (matchesByAsset[index] ?? []).map((matched) => ({ assetId: summary.assetId, matched })),
  );

  // Load each distinct CVE cache entry once, concurrently. Deduping before the
  // reads/writes avoids duplicate inserts when multiple assets expose the same
  // CVE, while Promise.all preserves deterministic CVE lookup results.
  const cveIdsToLoad = Array.from(new Set(matchedRows.map(({ matched }) => matched.cveId)));
  const cveMetadataEntries = await Promise.all(
    cveIdsToLoad.map(async (cveId) => {
      try {
        const exists = await prisma.cveEntry.findUnique({ where: { cveId } });
        if (exists) {
          return [cveId, { cvssScore: exists.cvssScore, severity: exists.severity }] as const;
        }

        const fetched = await fetchCve(cveId, apiKey);
        if (!fetched) return [cveId, null] as const;

        await prisma.cveEntry.create({
          data: {
            cveId: fetched.cveId,
            cvssScore: fetched.cvssScore,
            severity: fetched.severity,
            description: fetched.description,
            vector: fetched.vector,
            publishedAt: fetched.publishedAt,
          },
        });
        return [cveId, { cvssScore: fetched.cvssScore, severity: fetched.severity }] as const;
      } catch {
        // Best-effort — never break a scan on NVD or cache failures.
        return [cveId, null] as const;
      }
    }),
  );
  const cveMetadataById = new Map(cveMetadataEntries);
  const pending: PendingFinding[] = matchedRows.map(({ assetId, matched }) => {
    const metadata = cveMetadataById.get(matched.cveId);
    return {
      assetId,
      cveId: matched.cveId,
      severity: metadata?.severity || matched.severity,
      matchReason: matched.matchReason,
      cvssScore: metadata?.cvssScore ?? null,
    };
  });

  // Batch-fetch EPSS + KEV + VulnCheck in parallel for the deduped CVE-set.
  // All three fail softly: empty maps collapse priority to the no-intel
  // formula. VulnCheck degrades to empty map when no API token is configured
  // (no FOOTGUN: the env is optional by design).
  const cveIds = Array.from(new Set(pending.map((f) => f.cveId)));
  const [epssMap, kevMap, vulncheckMap] = await Promise.all([
    fetchEpssBatch(cveIds).catch(() => new Map<string, EpssEntry>()),
    fetchKevCatalog().catch(() => new Map<string, KevEntry>()),
    fetchVulncheckBatch(cveIds, env.VULNCHECK_API_TOKEN).catch(
      () => new Map<string, VulncheckHitRow>(),
    ),
  ]);

  const scored: ScoredFinding[] = pending.map((f) => {
    const epss = epssMap.get(f.cveId) ?? null;
    const kev = kevMap.get(f.cveId) ?? null;
    const vulncheck = vulncheckMap.get(f.cveId) ?? null;
    const priority = prioritizeFinding({
      cvssScore: f.cvssScore,
      epssScore: epss?.epssScore ?? null,
      severity: f.severity,
      kevListed: kev != null,
      vulncheckListed: vulncheck != null,
    });
    return { ...f, epss, kev, vulncheck, priority };
  });

  // Stable sort via the shared comparator in prioritize.ts (priority desc ->
  // vulncheckListed desc -> kevListed desc -> cvss desc -> severity rank desc
  // -> cveId asc) so the write side and read-side sort agree on rank.
  const sortKey = (f: ScoredFinding) => ({
    priorityScore: f.priority.priorityScore,
    severity: f.severity,
    cvssScore: f.cvssScore,
    cveId: f.cveId,
    kevListed: f.kev != null,
    vulncheckListed: f.vulncheck != null,
  });
  scored.sort((a, b) => compareFindings(sortKey(a), sortKey(b)));

  const findings: VulnerabilityFindingItem[] = [];
  const intelEvents: Array<{
    findingId: string;
    scanId: string;
    cveId: string;
    trigger: string;
    previousScore: number | null;
    nextScore: number | null;
    previousKev: boolean;
    nextKev: boolean;
    previousVc: boolean;
    nextVc: boolean;
  }> = [];
  const now = new Date();
  for (const f of scored) {
    const kevListedAt = f.kev ? parseKevDate(f.kev.dateAdded) : null;
    const vulncheckListedAt = f.vulncheck?.observedAt ?? null;
    const finding = await prisma.vulnerabilityFinding.create({
      data: {
        scanId: createdScanId,
        assetId: f.assetId,
        cveId: f.cveId,
        severity: f.severity,
        matchReason: f.matchReason,
        priorityScore: f.priority.priorityScore,
        epssScore: f.epss?.epssScore ?? null,
        epssPercentile: f.epss?.epssPercentile ?? null,
        kevListed: f.kev != null,
        kevListedAt,
        vulncheckListed: f.vulncheck != null,
        vulncheckObservedAt: vulncheckListedAt,
        lastRescoreAt: now,
        rescoreSource: 'scan',
      },
    });

    // Audit: every VulnCheck hit from the initial scan is worth a row —
    // surfaces "this CVE was already on VulnCheck when we first scanned it"
    // in the replay log. KEV-first-sighting is similarly marked.
    const vcOn = f.vulncheck != null;
    const kevOn = f.kev != null;
    const hadAnyTrigger = vcOn || kevOn;
    if (hadAnyTrigger && finding.priorityScore != null) {
      intelEvents.push({
        findingId: finding.id,
        scanId: finding.scanId,
        cveId: finding.cveId,
        trigger: 'scan',
        previousScore: null,
        nextScore: finding.priorityScore,
        previousKev: false,
        nextKev: kevOn,
        previousVc: false,
        nextVc: vcOn,
      });
      if (vcOn) {
        await prisma.vulncheckHit.upsert({
          where: {
            scanId_cveId_observedAt: {
              scanId: finding.scanId,
              cveId: finding.cveId,
              observedAt: vulncheckListedAt ?? now,
            },
          },
          create: {
            scanId: finding.scanId,
            cveId: finding.cveId,
            observedAt: vulncheckListedAt ?? now,
            evidence: f.vulncheck?.evidence ?? null,
            source: f.vulncheck?.source ?? 'vulncheck-nvd-cve',
          },
          update: {},
        });
      }
    }

    findings.push(
      FindingItemSchema.parse({
        id: finding.id,
        assetId: f.assetId,
        cveId: f.cveId,
        severity: f.severity,
        matchReason: f.matchReason,
        priorityScore: f.priority.priorityScore,
        epssScore: f.epss?.epssScore ?? null,
        epssPercentile: f.epss?.epssPercentile ?? null,
        kevListed: f.kev != null,
        kevListedAt: kevListedAt ? kevListedAt.toISOString() : null,
        vulncheckListed: f.vulncheck != null,
        vulncheckObservedAt: vulncheckListedAt ? vulncheckListedAt.toISOString() : null,
        lastRescoreAt: now.toISOString(),
        rescoreSource: 'scan',
        components: f.priority.components,
      }),
    );
  }

  if (intelEvents.length > 0) {
    await prisma.threatIntelEvent.createMany({ data: intelEvents });
  }

  const finishedAt = new Date();
  await prisma.scan.update({
    where: { id: createdScanId },
    data: { status: 'completed', finishedAt },
  });

  // Round-trip the persisted shape through the same contract the client parses.
  const assetItems: AssetItem[] = summaries.map((s) =>
    AssetItemSchema.parse({
      id: s.assetId,
      host,
      ip: ipString,
      port: s.port,
      protocol: 'tcp',
      state: s.state,
      latencyMs: s.latencyMs,
      serviceHint: s.serviceHint,
      banner: s.banner ? s.banner.slice(0, 500) : null,
    }),
  );

  return ScanItemSchema.parse({
    id: createdScanId,
    target: input.target,
    mode: 'tcp-only',
    status: 'completed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    assets: assetItems,
    findings,
    source: options.source ?? 'manual',
  });
}

async function resolveIp(target: string): Promise<LookupAddress> {
  // dns.lookup echoes literal IPs back unchanged, so the IPv6/IPv4/literal
  // cases are handled uniformly here.
  const records = await lookup(target, { all: true, verbatim: true });
  if (records.some((record) => !isPublicRoutableAddress(record.address))) {
    throw new UnsafeScanTargetError();
  }
  const v4 = records.find((r) => r.family === 4);
  const chosen = v4 ?? records[0];
  if (!chosen) {
    throw new Error(`dns lookup for ${target} returned no records`);
  }
  return chosen;
}

// Parse a CISA KEV dateAdded string (YYYY-MM-DD) into a Date. Returns null
// when the input is unparseable so the caller stores a null kevListedAt
// instead of a misleading epoch.
function parseKevDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
