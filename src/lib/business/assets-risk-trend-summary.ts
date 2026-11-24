// @polsia:user-owned — Pure client-safe summary for asset risk-score history.

import type { AssetRiskTrendPoint } from '@/lib/contracts/assets-risk-trend';

export interface RiskScoreChange {
  earliestScannedAt: string;
  earliestScore: number;
  latestScannedAt: string;
  latestScore: number;
  delta: number;
}

export function calculateRiskScoreChange(
  points: readonly AssetRiskTrendPoint[],
): RiskScoreChange | null {
  const usablePoints = points
    .filter((point) => {
      const timestamp = new Date(point.scannedAt).getTime();
      return Number.isFinite(timestamp) && Number.isFinite(point.score);
    })
    .toSorted((first, second) => {
      return new Date(first.scannedAt).getTime() - new Date(second.scannedAt).getTime();
    });

  if (usablePoints.length < 2) return null;

  const earliest = usablePoints[0];
  const latest = usablePoints.at(-1);

  if (!earliest || !latest) return null;

  return {
    earliestScannedAt: earliest.scannedAt,
    earliestScore: earliest.score,
    latestScannedAt: latest.scannedAt,
    latestScore: latest.score,
    delta: latest.score - earliest.score,
  };
}
