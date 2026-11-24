// @polsia:user-owned — Date-range input row for the /alerts page. Two
// `<Input type="date">` controls that drive `from` / `to` URL query
// params via `router.replace`. Reads initial values from
// `useSearchParams()` on mount and re-pushes on every commit; empty
// `from` / `to` strips the param so a fresh tab drops the chip from
// shareable URLs.
//
// Local validation keeps malformed or reversed bounds out of the URL
// writer and displays an inline error. The API validates the same date
// shapes and rejects reversed ranges before reading alerts.
//
// Does NOT call any `/api` — the parent page's useEffect on `qs`
// already drives the list fetch when the URL changes.

'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { AlertDateBound, isAlertDateRangeOrdered } from '@/lib/contracts/alert-date-range';

interface AlertsDateRangeInputProps {
  initialFrom?: string;
  initialTo?: string;
  // The path the input's URL write targets. Defaults to `/alerts`
  // (the page that ships this primitive); the per-host detail page
  // passes `/assets/<host>` so the date-range state round-trips on
  // the same filter band shape rather than forcing a re-mount of a
  // per-page component. See alerts-text-query-input.tsx:basePath for
  // the lockstep rationale.
  basePath?: string;
}

export function AlertsDateRangeInput({
  initialFrom = '',
  initialTo = '',
  basePath = '/alerts',
}: AlertsDateRangeInputProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `from` / `to` are the local-typed drafts. URL state is the source
  // of truth for the rest of the page; we never mirror it back once
  // mounted, so a manual URL edit in the address bar does not bleed
  // into these locals.
  const [from, setFrom] = useState<string>(() => initialFrom || searchParams.get('from') || '');
  const [to, setTo] = useState<string>(() => initialTo || searchParams.get('to') || '');

  // Re-push whenever either field changes — UNLESS the range is
  // reversed. Reversed → no push, and the inline warning handles the
  // operator feedback. Empty string → strip so a fresh tab drops the
  // chip from shareable URLs.
  //
  // Selection clearing happens at the page layer via the `viewKey`
  // useEffect in src/app/(dashboard)/alerts/page.tsx — the URL
  // mutates here without stripping `?selected=` because the page
  // reads the URL change, drops the working set, and re-writes the
  // URL through `effectiveQs` in one pass.
  useEffect(() => {
    const fromInvalid = from.length > 0 && !AlertDateBound.safeParse(from).success;
    const toInvalid = to.length > 0 && !AlertDateBound.safeParse(to).success;
    const rangeReversed = !fromInvalid && !toInvalid && !isAlertDateRangeOrdered(from, to);
    if (fromInvalid || toInvalid || rangeReversed) return;
    const params = new URLSearchParams(window.location.search);
    if (from.trim().length > 0) params.set('from', from.trim());
    else params.delete('from');
    if (to.trim().length > 0) params.set('to', to.trim());
    else params.delete('to');
    const qs = params.toString();
    const nextUrl = `${basePath}${qs ? `?${qs}` : ''}`;
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      router.replace(nextUrl, { scroll: false });
    }
    // Read the current query string at write time so a date edit keeps
    // chip or search updates already present in the browser URL.
  }, [from, to, router, basePath]);

  const onFrom = useCallback((next: string) => {
    setFrom(next);
  }, []);
  const onTo = useCallback((next: string) => {
    setTo(next);
  }, []);

  const fromInvalid = from.length > 0 && !AlertDateBound.safeParse(from).success;
  const toInvalid = to.length > 0 && !AlertDateBound.safeParse(to).success;
  const rangeReversed = !fromInvalid && !toInvalid && !isAlertDateRangeOrdered(from, to);

  return (
    <fieldset
      aria-label="Filter alerts by created-at date range"
      className="flex w-full min-w-0 flex-wrap items-center gap-2 border-0 p-0 m-0 md:w-auto"
    >
      <label htmlFor="alerts-date-from" className="flex items-center gap-1.5 text-caption">
        <span>From</span>
        <Input
          id="alerts-date-from"
          type="date"
          value={from}
          onChange={(event) => onFrom(event.target.value)}
          max="9999-12-31"
          aria-invalid={fromInvalid || rangeReversed}
          className="min-h-11 w-[10rem] md:min-h-9"
        />
      </label>
      <label htmlFor="alerts-date-to" className="flex items-center gap-1.5 text-caption">
        <span>To</span>
        <Input
          id="alerts-date-to"
          type="date"
          value={to}
          onChange={(event) => onTo(event.target.value)}
          max="9999-12-31"
          aria-invalid={toInvalid || rangeReversed}
          className="min-h-11 w-[10rem] md:min-h-9"
        />
      </label>
      {fromInvalid ? (
        <output className="text-caption text-muted-foreground">Enter a valid start date.</output>
      ) : toInvalid ? (
        <output className="text-caption text-muted-foreground">Enter a valid end date.</output>
      ) : rangeReversed ? (
        <output
          className="text-caption text-muted-foreground"
          title="The start date must be on or before the end date."
        >
          from must be on or before to
        </output>
      ) : null}
    </fieldset>
  );
}
