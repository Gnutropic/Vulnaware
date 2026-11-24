// @polsia:user-owned — URL-backed completed-scan filter for /assets.

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

interface AssetsNeverScannedFilterProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function AssetsNeverScannedFilter({ value, onChange }: AssetsNeverScannedFilterProps) {
  const selectedLabel = value ? 'Never scanned' : 'Any scan completion';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="assets-never-scanned-label" className="text-caption text-muted-foreground">
        Scan completion
      </span>
      <Select value={value ? 'never' : 'all'} onValueChange={(next) => onChange(next === 'never')}>
        <SelectTrigger
          type="button"
          aria-labelledby="assets-never-scanned-label"
          className="min-h-11 min-w-[13rem] rounded-full border-input px-4 text-left md:min-h-0 md:px-3"
        >
          <SelectValue aria-label={selectedLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Scan completion</SelectLabel>
            <SelectItem value="all" className="rounded-md">
              Any scan completion
            </SelectItem>
            <SelectItem value="never" className="rounded-md">
              Never scanned
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {value ? (
        <button
          type="button"
          onClick={() => onChange(false)}
          className="min-h-11 rounded-md px-2 text-caption font-medium text-brand-600 underline-offset-4 hover:underline md:min-h-0"
        >
          Clear Never scanned filter
        </button>
      ) : null}
    </div>
  );
}
