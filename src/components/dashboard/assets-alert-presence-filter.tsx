// @polsia:user-owned — URL-backed unresolved-alert presence control for
// /assets. The parent owns the value and URL persistence.

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
import type { AssetAlertPresence } from '@/lib/contracts/assets';

export const ASSET_ALERT_PRESENCE_OPTIONS: ReadonlyArray<{
  value: AssetAlertPresence;
  label: string;
}> = [
  { value: 'all', label: 'All assets' },
  { value: 'with', label: 'With unresolved alerts' },
  { value: 'without', label: 'Without unresolved alerts' },
];

interface AssetsAlertPresenceFilterProps {
  value: AssetAlertPresence;
  onChange: (value: AssetAlertPresence) => void;
}

export function AssetsAlertPresenceFilter({ value, onChange }: AssetsAlertPresenceFilterProps) {
  const selectedLabel =
    ASSET_ALERT_PRESENCE_OPTIONS.find((option) => option.value === value)?.label ?? 'All assets';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="assets-alert-presence-label" className="text-caption text-muted-foreground">
        Unresolved alerts
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as AssetAlertPresence)}>
        <SelectTrigger
          type="button"
          aria-labelledby="assets-alert-presence-label"
          className="min-h-11 min-w-[13rem] rounded-full border-input px-4 text-left md:min-h-0 md:px-3"
        >
          <SelectValue aria-label={selectedLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Unresolved alerts</SelectLabel>
            {ASSET_ALERT_PRESENCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="rounded-md">
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
