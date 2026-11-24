// @polsia:user-owned — URL-backed 30-day risk trend control for /assets.

'use client';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AssetRiskTrend } from '@/lib/contracts/assets';

export type AssetRiskTrendFilterValue = AssetRiskTrend | 'all';

export const ASSET_RISK_TREND_OPTIONS: ReadonlyArray<{
  value: AssetRiskTrendFilterValue;
  label: string;
}> = [
  { value: 'all', label: 'All risk trends' },
  { value: 'rising', label: 'Rising' },
  { value: 'falling', label: 'Falling' },
  { value: 'unchanged', label: 'Unchanged' },
];

interface AssetsRiskTrendFilterProps {
  value: AssetRiskTrendFilterValue;
  onChange: (value: AssetRiskTrendFilterValue) => void;
}

export function AssetsRiskTrendFilter({ value, onChange }: AssetsRiskTrendFilterProps) {
  const selectedLabel =
    ASSET_RISK_TREND_OPTIONS.find((option) => option.value === value)?.label ?? 'All risk trends';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="assets-risk-trend-label" className="text-caption text-muted-foreground">
        30-day risk trend
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as AssetRiskTrendFilterValue)}>
        <SelectTrigger
          type="button"
          aria-labelledby="assets-risk-trend-label"
          className="min-h-11 min-w-[11rem] rounded-full border-input px-4 text-left md:min-h-0 md:px-3"
        >
          <SelectValue aria-label={selectedLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>30-day risk trend</SelectLabel>
            {ASSET_RISK_TREND_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="rounded-md">
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {value !== 'all' ? (
        <button
          type="button"
          onClick={() => onChange('all')}
          className="min-h-11 rounded-md px-2 text-caption font-medium text-brand-600 underline-offset-4 hover:underline md:min-h-0"
        >
          Clear risk trend filter
        </button>
      ) : null}
    </div>
  );
}
