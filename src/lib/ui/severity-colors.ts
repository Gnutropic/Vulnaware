// @polsia:user-owned — Shared per-severity color tokens used by two
// surfaces:
//   1. /alerts's `AlertsSeverityChipRow` (active chip color)
//   2. /dashboard's `DashboardOpenBySeverity` tile (count color)
// Without a single source of truth, a future edit to one of the two
// surfaces silently breaks the brief's invariant that the tile and the
// chip row agree on per-level color. Every level exposes the same
// shape:
//   - `label`       — the canonical "Critical" / "High" / "Medium" / "Low"
//                     literal used by both surfaces.
//   - `chipActive`  — Tailwind class fragment applied to the chip row's
//                     active chip (`bg-<tone>-600 text-white` etc.).
//                     The "All" chip falls through to a separate entry
//                     using `bg-brand-600 text-primary-foreground` so
//                     the brand token still wins there.
//   - `panelRing`   — Tailwind class fragment painted on the tile cell's
//                     left edge (`border-l-<tone>-500` etc.) so the
//                     tile reads as a stacked severity-color band even
//                     at a glance.
//   - `countText`   — Tailwind class fragment applied to the big count
//                     number itself (`text-<tone>-600` etc.).
// Tones chosen to match the destructive-warm-amber-blue band already
// used in `src/components/custom/compliance/findings-by-control.tsx`
// (critical=destructive, high=destructive, medium=amber, low=blue) so
// the existing /compliance surface reads as the same family — no new
// visual vocabulary is introduced.
//
// The Snoozed token (`SNOOZED_COLOR_TOKEN`) is a separate family
// pinned alongside the severity band: the active Snoozed chip on
// /alerts reads as a violet-tinted chip + the count badge next to it
// uses the same violet count-text fragment so the chip and the badge
// agree on the per-filter color 1:1. Violet is intentionally distinct
// from destructive / amber / blue so the Snoozed chip reads as a
// separate filter family (a "snoozed = paused" metaphor) rather than
// slipping into the severity band. The lockstep between chip row +
// count badge is the same invariant the per-severity tokens already
// pin for the dashboard tile, just with one fewer consumer today.

import type { SeverityLiteral } from '@/lib/business/alerts-severity';

export type { SeverityLiteral };

export interface SeverityColorToken {
  label: string;
  chipActive: string;
  panelRing: string;
  countText: string;
}

export const ALL_SEVERITY_COLOR_TOKEN: SeverityColorToken = {
  label: 'All',
  chipActive: 'bg-brand-600 text-primary-foreground border-brand-600',
  panelRing: 'border-l-brand-500',
  countText: 'text-brand-600 dark:text-brand-400',
};

export const SNOOZED_COLOR_TOKEN: SeverityColorToken = {
  label: 'Snoozed',
  chipActive: 'bg-violet-500 text-white border-violet-500 dark:bg-violet-500/90',
  panelRing: 'border-l-violet-500',
  countText: 'text-violet-700 dark:text-violet-400',
};

export const CUSTOM_SEVERITY_COLOR_TOKEN: SeverityColorToken = {
  label: 'Custom severity',
  chipActive: 'bg-muted text-foreground border-border',
  panelRing: 'border-l-border',
  countText: 'text-muted-foreground',
};

export const SEVERITY_COLOR_TOKENS: ReadonlyArray<SeverityColorToken> = [
  {
    label: 'Critical',
    chipActive: 'bg-destructive text-destructive-foreground border-destructive',
    panelRing: 'border-l-destructive',
    countText: 'text-destructive dark:text-destructive',
  },
  {
    label: 'High',
    chipActive: 'bg-destructive/85 text-destructive-foreground border-destructive/70',
    panelRing: 'border-l-destructive/70',
    countText: 'text-destructive/90 dark:text-destructive/90',
  },
  {
    label: 'Medium',
    chipActive: 'bg-amber-500 text-white border-amber-500 dark:bg-amber-500/90',
    panelRing: 'border-l-amber-500',
    countText: 'text-amber-700 dark:text-amber-400',
  },
  {
    label: 'Low',
    chipActive: 'bg-blue-500 text-white border-blue-500 dark:bg-blue-500/90',
    panelRing: 'border-l-blue-500',
    countText: 'text-blue-700 dark:text-blue-400',
  },
];

export function severityColorToken(literal: SeverityLiteral): SeverityColorToken {
  switch (literal) {
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
