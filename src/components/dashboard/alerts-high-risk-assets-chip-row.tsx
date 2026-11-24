// @polsia:user-owned — High-risk asset filter chip for the /alerts page.

'use client';

import { Button } from '@/components/ui/button';

interface AlertsHighRiskAssetsChipRowProps {
  value: boolean;
  onChange: (next: boolean) => void;
}

export function AlertsHighRiskAssetsChipRow({ value, onChange }: AlertsHighRiskAssetsChipRowProps) {
  return (
    <fieldset
      aria-label="Filter alerts by associated asset risk"
      className="m-0 flex flex-wrap items-center gap-2 border-0 p-0"
    >
      <Button
        type="button"
        size="sm"
        variant={value ? 'default' : 'outline'}
        aria-pressed={value}
        data-active={value}
        onClick={() => onChange(!value)}
        className="min-h-11 rounded-full px-4 md:min-h-0 md:px-3"
      >
        High-risk assets only
      </Button>
    </fieldset>
  );
}
