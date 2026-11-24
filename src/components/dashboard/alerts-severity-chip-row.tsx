// @polsia:user-owned — Multi-select severity chip row for the /alerts
// page. Controlled component: the caller owns the active value (a
// `Set<SeverityLiteral>` OR `null` for the resting state) and re-fires
// /api/alerts when it changes. Renders the server-provided options plus
// the persistent "All" chip using the existing Button primitive. Multi-select posture — clicking a tier
// chip toggles its membership; clicking the last active tier off
// collapses to `null` so the page's `effectiveQs` writer strips the
// `?severity=` key on a full clear. The "All" chip is the resting
// state marker — it renders active when the Set is empty / null and
// inactive whenever any tier chip is active. Clicking "All" fires
// `onChange(null)` regardless of incoming Set membership, so a
// operator who hits "All" with a populated Set ends up at the broad
// view in one click (the role the asset chip row's trailing ghost
// "Clear" button plays — inverted here because the resting state IS
// the special chip rather than a hover gesture). Mirrors
// `alerts-asset-chip-row`'s multi-select Set semantics so the two
// rows render as one visual filter family.
//
// `aria-pressed` carries the screen-reader state per chip. Tier chips
// paint `chip.token.chipActive` (the per-severity color band from
// `@/lib/ui/severity-colors`) when active, so the lit chips visually
// match the row badges and the dashboard's "Open alerts by severity"
// tile — the brief's invariant that the band reads as the same color
// coding end-to-end. The "All" chip paints the brand color
// (`bg-brand-600 text-primary-foreground`) when active, distinct from
// the tier tones. The chip row itself is purely presentational — it
// never serializes a URL form, so `parseSeverityFilter` lives in the
// business lib and is called by the page (which is also where the
// legacy / dashboard-tile multi-value CSV permalink first lights up
// as a populated Set).

'use client';

import { Button } from '@/components/ui/button';
import type { SeverityLiteral } from '@/lib/business/alerts-severity';
import {
  ALL_SEVERITY_COLOR_TOKEN,
  CUSTOM_SEVERITY_COLOR_TOKEN,
  SEVERITY_COLOR_TOKENS,
  type SeverityColorToken,
} from '@/lib/ui/severity-colors';

interface AlertsSeverityChipRowProps {
  value: Set<SeverityLiteral> | null;
  onChange: (next: Set<SeverityLiteral> | null) => void;
  options: readonly SeverityLiteral[];
}

function severityLabel(value: SeverityLiteral): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}

function severityToken(value: SeverityLiteral): SeverityColorToken {
  switch (value.toLowerCase()) {
    case 'critical':
      return SEVERITY_COLOR_TOKENS[0] as SeverityColorToken;
    case 'high':
      return SEVERITY_COLOR_TOKENS[1] as SeverityColorToken;
    case 'medium':
      return SEVERITY_COLOR_TOKENS[2] as SeverityColorToken;
    case 'low':
      return SEVERITY_COLOR_TOKENS[3] as SeverityColorToken;
    default:
      return CUSTOM_SEVERITY_COLOR_TOKEN;
  }
}

export function AlertsSeverityChipRow({ value, onChange, options }: AlertsSeverityChipRowProps) {
  const activeSet = value ?? new Set<SeverityLiteral>();
  const hasTierActive = activeSet.size > 0;
  const isAllActive = !hasTierActive;
  return (
    <fieldset
      aria-label="Filter alerts by severity"
      className="flex min-w-0 w-full max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      <Button
        key="all"
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={isAllActive}
        data-active={isAllActive}
        onClick={() => onChange(null)}
        className={`min-h-11 rounded-full px-4 md:min-h-0 md:px-3 ${
          isAllActive ? ALL_SEVERITY_COLOR_TOKEN.chipActive : ''
        }`}
      >
        All
      </Button>
      {options.map((key) => {
        const chip = { key, label: severityLabel(key), token: severityToken(key) };
        const isActive = activeSet.has(chip.key);
        return (
          <Button
            key={chip.key}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={isActive}
            data-active={isActive}
            onClick={() => {
              const next = new Set(activeSet);
              if (next.has(chip.key)) next.delete(chip.key);
              else next.add(chip.key);
              onChange(next.size > 0 ? next : null);
            }}
            className={`min-h-11 rounded-full px-4 md:min-h-0 md:px-3 ${
              isActive ? chip.token.chipActive : ''
            }`}
          >
            {chip.label}
          </Button>
        );
      })}
    </fieldset>
  );
}
