// @polsia:user-owned — Load persisted per-scan risk scores for one host.
// Called only by GET /api/assets/[host]/risk-trend; keep Prisma access here
// and out of the page and client component.

import 'server-only';
import { calculateRiskScoreChange } from '@/lib/business/assets-risk-trend-summary';
import type { AssetRiskTrend as AssetRiskTrendFilter } from '@/lib/contracts/assets';
import {
  AssetRiskTrend,
  type AssetRiskTrend as AssetRiskTrendData,
} from '@/lib/contracts/assets-risk-trend';
import { prisma } from '@/lib/db';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function matchesAssetRiskTrend(
  riskScoreChange: number | null,
  riskTrend: AssetRiskTrendFilter | undefined,
): boolean {
  if (riskTrend === undefined) return true;
  if (riskScoreChange === null) return false;
  if (riskTrend === 'rising') return riskScoreChange > 0;
  if (riskTrend === 'falling') return riskScoreChange < 0;
  return riskScoreChange === 0;
}

interface AssetRiskChangeFinding {
  asset: { host: string };
  scanId: string;
  priorityScore: number | null;
  scan: { startedAt: Date };
}

export interface AssetRiskFinding {
  scanId: string;
  priorityScore: number | null;
  scan: { startedAt: Date };
}

export interface GroupedAssetRiskFinding {
  scanId: string;
  scannedAt: Date;
  score: number;
}

/** Reduce persisted findings to one maximum score per scan in display order. */
export function groupAssetRiskFindings(
  findings: readonly AssetRiskFinding[],
): GroupedAssetRiskFinding[] {
  const byScan = new Map<string, GroupedAssetRiskFinding>();
  for (const finding of findings) {
    const score = finding.priorityScore;
    const timestamp = finding.scan.startedAt.getTime();
    if (score === null || !Number.isFinite(score) || !Number.isFinite(timestamp)) continue;

    const existing = byScan.get(finding.scanId);
    if (!existing || score > existing.score) {
      byScan.set(finding.scanId, {
        scanId: finding.scanId,
        scannedAt: finding.scan.startedAt,
        score,
      });
    }
  }

  return [...byScan.values()].sort(
    (a, b) => a.scannedAt.getTime() - b.scannedAt.getTime() || a.scanId.localeCompare(b.scanId),
  );
}

export async function loadAssetRiskTrend(
  teamId: string,
  host: string,
  now: Date = new Date(),
): Promise<AssetRiskTrendData> {
  const from = new Date(now.getTime() - THIRTY_DAYS_MS);
  const findings = await prisma.vulnerabilityFinding.findMany({
    where: {
      priorityScore: { not: null },
      asset: { host },
      scan: {
        teamId,
        startedAt: { gte: from, lte: now },
      },
    },
    select: {
      scanId: true,
      priorityScore: true,
      scan: { select: { startedAt: true } },
    },
    orderBy: [{ scan: { startedAt: 'asc' } }, { scanId: 'asc' }],
  });

  const series = groupAssetRiskFindings(findings).map(({ scannedAt, score }) => ({
    scannedAt: scannedAt.toISOString(),
    score,
  }));

  return AssetRiskTrend.parse({ host, series });
}

export async function loadAssetRiskChanges(
  teamId: string,
  hosts: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, number | null>> {
  const changes = new Map<string, number | null>(hosts.map((host) => [host, null]));
  if (hosts.length === 0) return changes;

  const from = new Date(now.getTime() - THIRTY_DAYS_MS);
  const findings = await prisma.vulnerabilityFinding.findMany({
    where: {
      priorityScore: { not: null },
      asset: { host: { in: [...new Set(hosts)] } },
      scan: {
        teamId,
        startedAt: { gte: from, lte: now },
      },
    },
    select: {
      asset: { select: { host: true } },
      scanId: true,
      priorityScore: true,
      scan: { select: { startedAt: true } },
    },
  });

  const byHost = new Map<string, AssetRiskChangeFinding[]>();
  for (const finding of findings as AssetRiskChangeFinding[]) {
    const hostFindings = byHost.get(finding.asset.host) ?? [];
    hostFindings.push(finding);
    byHost.set(finding.asset.host, hostFindings);
  }

  for (const [host, hostFindings] of byHost) {
    const points = groupAssetRiskFindings(hostFindings).map(({ scannedAt, score }) => ({
      scannedAt: scannedAt.toISOString(),
      score,
    }));
    if (points.length === 0) continue;
    changes.set(host, calculateRiskScoreChange(points)?.delta ?? null);
  }

  return changes;
}
