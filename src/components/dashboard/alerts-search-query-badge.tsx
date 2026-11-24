// @polsia:user-owned — Removable badge for the active `?q=` text-query
// on the /alerts page. Renders the active query as a chip-band-styled
// Button ("Search: <q>") PLUS an inline ghost X icon Button that
// strips `q` and `selected` from the URL — so the search state
// survives navigation AND a single click on X removes it without
// disturbing other chip-state keys (status / ownedBy / severity / etc.).
//
// Styling fingerprint matches every other chip-band chip on /alerts
// (`min-h-11 rounded-full px-4 md:min-h-0 md:px-3`) so the badge
// reads as part of the surrounding filter band and not as a bolt-on
// widget. The main Button always renders `aria-pressed="true" +
// data-active="true"` because the badge is ALWAYS active when
// `value` is non-empty — there's no toggle UX here, only the X strip.
// Inline ghost X Button mirrors the inline ghost X in
// `AlertsSeverityChipRow`'s Clear button + `AlertsTextQueryInput`'s
// clear button: same aria-label="Clear search" + size="sm" +
// variant="ghost" — so the chip-band visual weight matches.
//
// Page-level lazy-init for `q` is the page-level pipeline
// (`parseFiltersFromParams(initialSearchParams).q`) so the badge
// reads from the same source the chip rows read from — no separate
// input drift. The input island (`alerts-text-query-input`) still
// owns the URL write for keystroke & clear-button writes; this
// badge owns the X click strip. Both write to the same URL so a
// click on either surface lands on `/alerts` with `q` (and
// `selected`, on any keystroke) dropped from the query string.
//
// Empty / whitespace-only `value` → returns `null` so the page never
// renders an empty chip band slot. Truncates long labels to ≤ 60
// chars with a trailing ellipsis so a 200-char pasted URL value
// doesn't blow out the chip row layout; the full value is preserved
// on the `<span title=…>` for hover-tooltip recovery.

'use client';

import { X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface AlertsSearchQueryBadgeProps {
  value: string;
}

const MAX_LABEL_LENGTH = 60;

export function AlertsSearchQueryBadge({ value }: AlertsSearchQueryBadgeProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const label =
    trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.slice(0, MAX_LABEL_LENGTH)}…` : trimmed;

  const onClear = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    params.delete('selected');
    const qs = params.toString();
    router.replace(`/alerts${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  return (
    <fieldset
      aria-label="Active search query"
      className="flex flex-row flex-nowrap items-center gap-2 border-0 p-0 m-0"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed="true"
        data-active="true"
        className="min-h-11 rounded-full px-4 md:min-h-0 md:px-3"
      >
        <span className="mr-1.5 text-caption text-muted-foreground">Search:</span>
        <span title={trimmed} className="font-mono text-caption">
          {label}
        </span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Clear search"
        onClick={onClear}
        className="min-h-11 rounded-full px-3 md:min-h-0 md:px-2"
      >
        <X className="size-4" aria-hidden />
      </Button>
    </fieldset>
  );
}
