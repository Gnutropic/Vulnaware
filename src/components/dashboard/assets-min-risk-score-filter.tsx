// @polsia:user-owned — URL-backed minimum risk-score filter for /assets.
// The parent owns the parsed value and API query; this island owns the
// accessible control and mutates only its own URL key.

'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AssetsMinRiskScoreFilterProps {
  value: number | null;
  onChange: (next: number | null) => void;
}

function isValidRiskScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 10;
}

export function AssetsMinRiskScoreFilter({ value, onChange }: AssetsMinRiskScoreFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateUrl(rawValue: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (rawValue === '') {
      params.delete('minRiskScore');
      onChange(null);
    } else {
      const nextValue = Number(rawValue);
      if (!isValidRiskScore(nextValue)) return;
      params.set('minRiskScore', rawValue);
      onChange(nextValue);
    }

    const query = params.toString();
    router.replace(`/assets${query ? `?${query}` : ''}`, { scroll: false });
  }

  return (
    <div className="flex w-full flex-col gap-1 md:w-40">
      <Label htmlFor="assets-min-risk-score">Minimum risk score</Label>
      <Input
        id="assets-min-risk-score"
        type="number"
        min={0}
        max={10}
        step={0.1}
        inputMode="decimal"
        placeholder="Any score"
        value={value ?? ''}
        onChange={(event) => updateUrl(event.target.value)}
        aria-describedby="assets-min-risk-score-help"
      />
      <span id="assets-min-risk-score-help" className="text-caption text-muted-foreground">
        Include scores from 0 to 10
      </span>
    </div>
  );
}
