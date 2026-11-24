// @polsia:user-owned — Per-filter count badge strip for the /alerts page.
// Rendered just above the alerts table; the badges mirror the count badges
// on the existing alerts-source-chip-row's design family — a flat row of
// small `<Badge variant="...">` slots, one per filter tier (4 severity
// tiers + 1 Snoozed). The container carries `aria-label="Alerts by filter
// count"` as a static-name region (no aria-live) so screen-reader
// announcements don't shift on every chip click.
//
// Each severity badge shows the matching count in the current filtered
// inventory. The list never reaches zero elegantly when filtered; we keep all
// five badges visible so the operator always sees the full per-filter picture
// — the active chip is signalled by the chip-row's `default` variant.
//
// The Snoozed badge uses the same `SNOOZED_COLOR_TOKEN.countText`
// fragment the chip's active class fragments use (and source the same
// Snoozed label the AlertsSnoozedChipRow chip body shows), so the chip
// and the count badge read as the same color band across the filter row
// — the lockstep invariant the per-severity colors.ts tokens already pin.

'use client';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { AlertCounts } from '@/lib/contracts/alerts';
import { SNOOZED_COLOR_TOKEN } from '@/lib/ui/severity-colors';

interface AlertsCountBadgesProps {
  // The envelope's counts sub-object — null while the first fetch is in
  // flight so the badges can show a skeleton pair per slot.
  counts: AlertCounts | null;
}

const TIER_VARIANT: Record<keyof AlertCounts, 'destructive' | 'outline'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'outline',
  low: 'outline',
  snoozed: 'outline',
};

const TIER_LABEL: Record<keyof AlertCounts, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  snoozed: SNOOZED_COLOR_TOKEN.label,
};

const TIER_TONE: Record<keyof AlertCounts, string | null> = {
  critical: null,
  high: null,
  medium: null,
  low: null,
  // Snoozed paints the count number itself with the same color the
  // chip row paints on its active chip — so the chip and the badge
  // agree on the per-filter color 1:1 across the filter band. Pulled
  // straight from `SNOOZED_COLOR_TOKEN.countText` so the brief's
  // "lockstep with severity's color token" invariant survives a
  // future token table edit.
  snoozed: SNOOZED_COLOR_TOKEN.countText,
};

const TIERS: ReadonlyArray<keyof AlertCounts> = ['critical', 'high', 'medium', 'low', 'snoozed'];

export function AlertsCountBadges({ counts }: AlertsCountBadgesProps) {
  return (
    <fieldset
      aria-label="Alerts by filter count"
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
    >
      {TIERS.map((tier) => {
        const value = counts?.[tier];
        // Skeleton is rendered while `counts` is null (very first envelope
        // hasn't returned — avoids a layout shift on the first load). Once a
        // real payload lands the skeleton is replaced with a Badge that
        // visually echoes the per-row severity badge so the wizard-of-oz
        // shape matches the settled view.
        if (value == null) {
          return <Skeleton key={tier} className="h-5 w-[6.5rem] rounded-md" aria-hidden="true" />;
        }
        const tone = TIER_TONE[tier];
        return (
          <Badge
            key={tier}
            variant={TIER_VARIANT[tier]}
            className={`font-mono text-caption uppercase tracking-wider${tone ? ` ${tone}` : ''}`}
          >
            {TIER_LABEL[tier]} {value}
          </Badge>
        );
      })}
    </fieldset>
  );
}
