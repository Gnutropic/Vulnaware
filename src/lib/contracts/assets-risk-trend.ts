// @polsia:user-owned — Shared wire contract for per-scan risk-score history.
// The server route and client island both validate this response so date or
// score changes cannot drift between the data layer and the detail view.

import { z } from 'zod';
import { AssetDetailPathParam } from '@/lib/contracts/assets-detail';

export { AssetDetailPathParam };

export const AssetRiskTrendPoint = z.object({
  scannedAt: z.string().datetime(),
  score: z.number().finite(),
});
export type AssetRiskTrendPoint = z.infer<typeof AssetRiskTrendPoint>;

export const AssetRiskTrend = z.object({
  host: z.string(),
  series: z.array(AssetRiskTrendPoint),
});
export type AssetRiskTrend = z.infer<typeof AssetRiskTrend>;
