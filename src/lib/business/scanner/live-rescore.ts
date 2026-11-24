// @polsia:user-owned — Live threat-intel rescoring orchestrator. Given the
// current (Kev ∪ Epss ∪ VulnCheck) state and the set of persisted
// VulnerabilityFinding rows, diff + apply the new priority formula in a
// single batched transaction, write VulncheckHit append-only rows for new
// sightings, write ThreatIntelEvent audit rows for every bumped finding, and
// advance IntelFeedCursor. The cron (jobs/threat-intel-ingest.ts) and the
// on-demand /api/scan/[id]/rescore route handler both delegate to this.
//
// Touches ONLY @/lib/db plus the three intel clients and the prioritize
// pure module — no probe, no external network beyond the three intel feeds,
// no writes outside {VulnerabilityFinding, IntelFeedCursor, VulncheckHit,
// ThreatIntelEvent}.

import 'server-only';
import type { Prisma } from '@prisma/client';
import { appendAlertsForBumps } from '@/lib/business/alerts';
import { type EpssEntry, fetchEpssBatch } from '@/lib/business/scanner/epss';
import { fetchKevCatalog, type KevEntry } from '@/lib/business/scanner/kev';
import { compareFindings, prioritizeFinding } from '@/lib/business/scanner/prioritize';
import { fetchVulncheckBatch, type VulncheckHit } from '@/lib/business/scanner/vulncheck';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

// Numeric delta that qualifies a finding as "bumped" (worth a ThreatIntelEvent
// row). Set well above float noise (~1e-9) but below user-perceivable — a
// 0.05 shift lands above the EPSS_WEIGHT effect of a 1pp EPSS bump.
const BUMP_DELTA = 0.05;

export interface RescoreTrigger {
  trigger: string;
}

export interface RescoreResult {
  scanned: number;
  bumped: number;
  vulncheckSightings: number;
  top: Array<{
    findingId: string;
    cveId: string;
    previousScore: number | null;
    nextScore: number | null;
  }>;
}

export async function rescoreScan(scanId: string, trigger: RescoreTrigger): Promise<RescoreResult> {
  const persisted = await prisma.vulnerabilityFinding.findMany({
    where: { scanId },
    select: {
      id: true,
      cveId: true,
      priorityScore: true,
      kevListed: true,
      vulncheckListed: true,
      scanId: true,
    },
  });
  if (persisted.length === 0) {
    return { scanned: 0, bumped: 0, vulncheckSightings: 0, top: [] };
  }
  return rescoreByCveIds(
    persisted.map((p) => ({
      findingId: p.id,
      cveId: p.cveId,
      prevScore: p.priorityScore,
      scanId: p.scanId,
    })),
    trigger,
  );
}

interface RescoreRow {
  findingId: string;
  scanId: string;
  cveId: string;
  prevScore: number | null;
  cvss: number | null;
  severity: string | null;
  epss: EpssEntry | null;
  kev: KevEntry | null;
  vulncheck: VulncheckHit | null;
  nextScore: number | null;
}

export async function rescoreByCveIds(
  rows: Array<{ findingId: string; cveId: string; prevScore: number | null; scanId: string }>,
  trigger: RescoreTrigger,
): Promise<RescoreResult> {
  if (rows.length === 0) {
    return { scanned: 0, bumped: 0, vulncheckSightings: 0, top: [] };
  }
  const cveIds = Array.from(new Set(rows.map((r) => r.cveId)));

  // Pull CVSS so the priority formula has full inputs. CVSS lives on
  // CveEntry (cached NVD), NOT on VulnerabilityFinding itself.
  const cveEntries = await prisma.cveEntry.findMany({
    where: { cveId: { in: cveIds } },
    select: { cveId: true, cvssScore: true, severity: true },
  });
  const cvssByCve = new Map(cveEntries.map((e) => [e.cveId, e]));
  // Severities are stamped onto VulnerabilityFinding rows directly. Pull
  // them too so the formula's severity-fallback path produces the same
  // score as run-scan.ts did at ingestion time.
  const findingMeta = await prisma.vulnerabilityFinding.findMany({
    where: { id: { in: rows.map((r) => r.findingId) } },
    select: { id: true, severity: true },
  });
  const severityByFinding = new Map(findingMeta.map((m) => [m.id, m.severity]));

  // Fetch all three feeds in parallel; they fail softly → empty maps.
  const [epssMap, kevMap, vcMap] = await Promise.all([
    fetchEpssBatch(cveIds).catch(() => new Map<string, EpssEntry>()),
    fetchKevCatalog().catch(() => new Map<string, KevEntry>()),
    fetchVulncheckBatch(cveIds, env.VULNCHECK_API_TOKEN).catch(
      () => new Map<string, VulncheckHit>(),
    ),
  ]);

  const rescored: RescoreRow[] = rows.map((row) => {
    const entry = cvssByCve.get(row.cveId);
    const vulncheck = vcMap.get(row.cveId) ?? null;
    const priority = prioritizeFinding({
      cvssScore: entry?.cvssScore ?? null,
      epssScore: epssMap.get(row.cveId)?.epssScore ?? null,
      severity: severityByFinding.get(row.findingId) ?? entry?.severity ?? null,
      kevListed: kevMap.has(row.cveId),
      vulncheckListed: vulncheck != null,
    });
    return {
      findingId: row.findingId,
      scanId: row.scanId,
      cveId: row.cveId,
      prevScore: row.prevScore,
      cvss: entry?.cvssScore ?? null,
      severity: severityByFinding.get(row.findingId) ?? entry?.severity ?? null,
      epss: epssMap.get(row.cveId) ?? null,
      kev: kevMap.get(row.cveId) ?? null,
      vulncheck,
      nextScore: priority.priorityScore,
    };
  });

  const persisted2 = await prisma.vulnerabilityFinding.findMany({
    where: { id: { in: rows.map((r) => r.findingId) } },
    select: { id: true, kevListed: true, vulncheckListed: true },
  });
  const persistedMap = new Map(persisted2.map((p) => [p.id, p]));

  const now = new Date();
  const bumped: RescoreRow[] = [];
  for (const r of rescored) {
    const prevScore = r.prevScore;
    const nextScore = r.nextScore;
    const isBumped =
      prevScore == null || nextScore == null || Math.abs(nextScore - prevScore) >= BUMP_DELTA;
    if (isBumped) bumped.push(r);
  }

  await prisma.$transaction(async (tx) => {
    for (const r of bumped) {
      const next = r.nextScore ?? 0;
      const kevListed = r.kev != null;
      const kevListedAt = r.kev ? parseKevDate(r.kev.dateAdded) : null;
      await tx.vulnerabilityFinding.update({
        where: { id: r.findingId },
        data: {
          priorityScore: next,
          epssScore: r.epss?.epssScore ?? null,
          epssPercentile: r.epss?.epssPercentile ?? null,
          kevListed,
          kevListedAt,
          vulncheckListed: r.vulncheck != null,
          vulncheckObservedAt: r.vulncheck?.observedAt ?? null,
          lastRescoreAt: now,
          rescoreSource: trigger.trigger,
        },
      });
    }

    if (bumped.length > 0) {
      await tx.threatIntelEvent.createMany({
        data: bumped.map((r) => {
          const persistedRow = persistedMap.get(r.findingId);
          return {
            findingId: r.findingId,
            scanId: r.scanId,
            cveId: r.cveId,
            trigger: trigger.trigger,
            previousScore: r.prevScore,
            nextScore: r.nextScore,
            previousKev: persistedRow?.kevListed ?? false,
            nextKev: r.kev != null,
            previousVc: persistedRow?.vulncheckListed ?? false,
            nextVc: r.vulncheck != null,
            observedAt: now,
          };
        }),
      });
    }

    const newSightings = bumped.filter((r) => r.vulncheck != null);
    for (const r of newSightings) {
      const hit = r.vulncheck;
      if (!hit) continue;
      const observedAt = hit.observedAt ?? now;
      await tx.vulncheckHit.upsert({
        where: {
          scanId_cveId_observedAt: {
            scanId: r.scanId,
            cveId: r.cveId,
            observedAt,
          },
        },
        create: {
          scanId: r.scanId,
          cveId: r.cveId,
          observedAt,
          evidence: hit.evidence ?? null,
          source: hit.source ?? 'vulncheck-nvd-cve',
        },
        update: { evidence: hit.evidence ?? null },
      });
    }

    await advanceCursors(tx, {
      kev: kevMap.size,
      epss: epssMap.size,
      vulncheck: vcMap.size,
    });
  });

  // Fire-and-forget per-team alert write OUTSIDE the rescore transaction.
  // A failed row never blocks this scan; the row-level `.catch(() => {})`
  // already swallows prisma.errors. Mirrors recordIntelError's posture:
  // observability/log writes must never break a scan on their own failure.
  try {
    await appendAlertsForBumps(
      bumped.map((r) => ({
        findingId: r.findingId,
        scanId: r.scanId,
        severity: r.severity,
        kev: r.kev,
        vulncheck: r.vulncheck,
      })),
      { now, persistedMap },
    );
  } catch {
    // Swallow — alert writes are an observability layer, same posture as the
    // cursor advance above.
  }

  // Top findings by the fresh rescore, sliced to the first 3.
  const top = bumped
    .slice()
    .sort((a, b) => {
      const aKey = {
        priorityScore: a.nextScore,
        severity: a.severity,
        cvssScore: a.cvss,
        cveId: a.cveId,
        kevListed: a.kev != null,
        vulncheckListed: a.vulncheck != null,
      };
      const bKey = {
        priorityScore: b.nextScore,
        severity: b.severity,
        cvssScore: b.cvss,
        cveId: b.cveId,
        kevListed: b.kev != null,
        vulncheckListed: b.vulncheck != null,
      };
      return compareFindings(aKey, bKey);
    })
    .slice(0, 3)
    .map((r) => ({
      findingId: r.findingId,
      cveId: r.cveId,
      previousScore: r.prevScore,
      nextScore: r.nextScore,
    }));

  const vulncheckSightings = bumped.filter((r) => r.vulncheck != null).length;

  return {
    scanned: rescored.length,
    bumped: bumped.length,
    vulncheckSightings,
    top,
  };
}

async function advanceCursors(
  tx: Prisma.TransactionClient,
  sizes: { kev: number; epss: number; vulncheck: number },
): Promise<void> {
  const now = new Date();
  const entries: Array<{ feed: string; itemsSeen: number }> = [
    { feed: 'kev', itemsSeen: sizes.kev },
    { feed: 'epss', itemsSeen: sizes.epss },
    { feed: 'vulncheck', itemsSeen: sizes.vulncheck },
  ];
  for (const e of entries) {
    await tx.intelFeedCursor.upsert({
      where: { feed: e.feed },
      create: {
        feed: e.feed,
        lastFetchedAt: now,
        lastSuccessAt: now,
        itemsSeen: e.itemsSeen,
      },
      update: {
        lastFetchedAt: now,
        lastSuccessAt: now,
        itemsSeen: e.itemsSeen,
        lastError: null,
        lastErrorAt: null,
      },
    });
  }
}

export async function recordIntelError(
  feed: 'kev' | 'epss' | 'vulncheck',
  message: string,
): Promise<void> {
  try {
    await prisma.intelFeedCursor.upsert({
      where: { feed },
      create: {
        feed,
        lastFetchedAt: new Date(),
        lastErrorAt: new Date(),
        lastError: message.slice(0, 500),
      },
      update: {
        lastFetchedAt: new Date(),
        lastErrorAt: new Date(),
        lastError: message.slice(0, 500),
      },
    });
  } catch {
    // Swallow — the cursor is observability only; never break a scan on
    // its write failure.
  }
}

function parseKevDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
