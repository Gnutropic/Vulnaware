// @polsia:user-owned — Multi-select asset filter chip row for the
// /alerts page. Controlled component: the caller owns the active Set
// and re-fires /api/alerts when it changes. The chips derive from the
// `options` prop (sourced from `/api/alerts/asset-options`, top-N
// distinct assets on the team + per-asset alert count) — NOT from a
// sealed enum, because the asset wire identity `${host}:${port}
// /${protocol}` is open-ended (free-form per row over the joined
// `VulnerabilityFinding → Asset` path).
//
// Renders up to `maxItems` chips inside a labeled fieldset (default
// 10). When more options exist than `maxItems`, an aria-disabled
// informational pill renders OUTSIDE the active set so a reader sees
// how many extra assets exist but cannot toggle them in v1. When the
// Set is non-empty a trailing ghost-variant `Clear` button fires
// `onChange(null)` so the page's `effectiveQs` writer drops the
// `?asset=` key cleanly. Pattern mirrors `alerts-severity-chip-row`
// and `alerts-owner-chip-row` so the seven sibling rows render as one
// band — same fieldset shape, same Button sizes, same aria-pressed
// semantics. Pure presentational: no apiFetch, no DB, no URL writer.

'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface AssetFilterOption {
  name: string;
  count: number;
}

interface AlertsAssetChipRowProps {
  value: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  options: AssetFilterOption[];
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 10;
const OVERFLOW_PILL_LABEL_BEFORE = '+';
const OVERFLOW_PILL_LABEL_AFTER = 'more';

export function AlertsAssetChipRow({
  value,
  onChange,
  options,
  maxItems = DEFAULT_MAX_ITEMS,
}: AlertsAssetChipRowProps) {
  const activeSet = value ?? new Set<string>();
  const hasSelection = activeSet.size > 0;
  const visibleOptions = options.slice(0, maxItems);
  const overflowCount = options.length - visibleOptions.length;
  return (
    <fieldset
      aria-label="Filter alerts by asset"
      className="flex min-w-0 w-full max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {visibleOptions.map((opt) => {
        const isActive = activeSet.has(opt.name);
        return (
          <Button
            key={opt.name}
            type="button"
            size="sm"
            variant={isActive ? 'default' : 'outline'}
            aria-pressed={isActive}
            data-active={isActive}
            aria-label={`${opt.name}, ${opt.count} alerts`}
            onClick={() => {
              const next = new Set(activeSet);
              if (next.has(opt.name)) next.delete(opt.name);
              else next.add(opt.name);
              onChange(next.size > 0 ? next : null);
            }}
            className="min-h-11 min-w-0 max-w-full rounded-full px-4 md:min-h-0 md:px-3"
          >
            <span className="min-w-0 truncate font-mono text-caption">{opt.name}</span>{' '}
            <span className="ml-1.5 shrink-0 text-caption tabular-nums text-muted-foreground">
              {opt.count}
            </span>
          </Button>
        );
      })}
      {overflowCount > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-disabled="true"
          data-overflow="true"
          tabIndex={-1}
          className="min-h-11 cursor-default rounded-full px-4 opacity-70 md:min-h-0 md:px-3"
          onClick={(e) => {
            // Explicit no-op: a future popover expansion wires this up
            // for v2. Blocking click in v1 keeps the pill visibly
            // informational without a stale half-active state.
            e.preventDefault();
          }}
        >
          {OVERFLOW_PILL_LABEL_BEFORE}
          {overflowCount} {OVERFLOW_PILL_LABEL_AFTER}
        </Button>
      ) : null}
      {hasSelection ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Clear asset filter"
          onClick={() => onChange(null)}
          className="min-h-11 rounded-full px-4 md:min-h-0 md:px-3"
        >
          <X className="size-4" aria-hidden />
          Clear
        </Button>
      ) : null}
    </fieldset>
  );
}
