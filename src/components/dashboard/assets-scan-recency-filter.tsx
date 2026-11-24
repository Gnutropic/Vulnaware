// @polsia:user-owned — URL-backed scan-recency control for the /assets page.

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
import type { AssetScanRecency } from '@/lib/contracts/assets';

export const ASSET_SCAN_RECENCY_OPTIONS: ReadonlyArray<{
  value: AssetScanRecency;
  label: string;
}> = [
  { value: 'all', label: 'All scan history' },
  { value: 'last24h', label: 'Scanned in the last 24 hours' },
  { value: 'last7d', label: 'Scanned in the last 7 days' },
  { value: 'last30d', label: 'Scanned in the past 30 days' },
  { value: 'noRecent30d', label: 'No scans in the past 30 days' },
  { value: 'older', label: 'Stale (more than 30 days)' },
  { value: 'never', label: 'No scan history' },
];

interface AssetsScanRecencyFilterProps {
  value: AssetScanRecency;
  onChange: (value: AssetScanRecency) => void;
}

export function AssetsScanRecencyFilter({ value, onChange }: AssetsScanRecencyFilterProps) {
  const selectedLabel =
    ASSET_SCAN_RECENCY_OPTIONS.find((option) => option.value === value)?.label ??
    'All scan history';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="assets-scan-recency-label" className="text-caption text-muted-foreground">
        Scan recency
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as AssetScanRecency)}>
        <SelectTrigger
          type="button"
          aria-labelledby="assets-scan-recency-label"
          className="min-h-11 min-w-[13rem] rounded-full border-input px-4 text-left md:min-h-0 md:px-3"
        >
          <SelectValue aria-label={selectedLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Scan recency</SelectLabel>
            {ASSET_SCAN_RECENCY_OPTIONS.map((option) => (
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
          Clear scan recency filter
        </button>
      ) : null}
    </div>
  );
}
