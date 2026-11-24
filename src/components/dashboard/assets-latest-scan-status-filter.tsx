// @polsia:user-owned — Latest scan outcome filter for the /assets inventory.

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
import type { AssetScanStatus } from '@/lib/contracts/assets';

export const ASSET_LATEST_SCAN_STATUS_OPTIONS: ReadonlyArray<{
  value: 'all' | AssetScanStatus;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

interface AssetsLatestScanStatusFilterProps {
  value: AssetScanStatus | null;
  onChange: (value: AssetScanStatus | null) => void;
}

export function AssetsLatestScanStatusFilter({
  value,
  onChange,
}: AssetsLatestScanStatusFilterProps) {
  const selectedValue = value ?? 'all';
  const selectedLabel =
    ASSET_LATEST_SCAN_STATUS_OPTIONS.find((option) => option.value === selectedValue)?.label ??
    'All';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="assets-latest-scan-status-label" className="text-caption text-muted-foreground">
        Latest scan status
      </span>
      <Select
        value={selectedValue}
        onValueChange={(next) => onChange(next === 'all' ? null : (next as AssetScanStatus))}
      >
        <SelectTrigger
          type="button"
          aria-labelledby="assets-latest-scan-status-label"
          className="min-h-11 min-w-[11rem] rounded-full border-input px-4 text-left md:min-h-0 md:px-3"
        >
          <SelectValue aria-label={selectedLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Latest scan status</SelectLabel>
            {ASSET_LATEST_SCAN_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="rounded-md">
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {value ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="min-h-11 rounded-md px-2 text-caption font-medium text-brand-600 underline-offset-4 hover:underline md:min-h-0"
        >
          Clear latest scan status filter
        </button>
      ) : null}
    </div>
  );
}
