// @polsia:user-owned — Free-form text query input for the /alerts page.
// Reads initial value from `useSearchParams` on mount and pushes `q`
// into the URL via `router.replace` after a 200ms idle debounce, so a
// continuous keystroke doesn't fire a URL replace per character and
// pile up history entries. Empty → strip `q` so a fresh tab drops the
// chip from shareable URLs; non-empty → set `q`. Does NOT call any
// `/api` — the parent page already drives the list fetch via a single
// `useEffect` on the URL.
// `router.replace` (not push) so the back button still leaves /alerts
// instead of stepping through every chip click. The visible text is
// NOT debounced — the user types into the control immediately; only
// the URL write is throttled.
//
// URL-write collision posture: the chip-row chips also drive the URL
// via the page's `qs → URL` writer. To avoid a chip flip silently
// dropping `q`, the page's `qs` builder merges the chip-state values
// with the URL's current `q` / `from` / `to` keys. This island reads
// all current params from the browser URL when the debounce fires,
// mutates only the `q` key, then writes back. An out-of-band chip
// toggle on the same page therefore preserves `q` rather than
// overwriting it.
//
// Clear button: when the draft is non-empty, an inline ghost-styled
// button with the X icon sits inside the same label as the input.
// Clicking it sets `text` to `''`; the same debounced URL writer then
// strips `q` from the URL after the next idle tick, mirroring the
// user backspacing the field manually.
//
// Wrapper tokens: the outer `<label>` matches the sort selector's
// pill token family verbatim (`min-h-11 rounded-full border-input
// px-4 md:min-h-0 md:px-3`) — see `alerts-sort-select.tsx:73-78` for
// the lockstep reference — so the date-range → sort → search band
// reads as one continuous row of pill-shaped controls. We render a
// borderless native `<input type="search">` inside that wrapper so
// the wrapper owns the visual contract (rather than leaning on the
// shadcn `<Input>` primitive, whose rounded-md border would visually
// clash with the sort's rounded-full pill). The clear X re-tokened
// to `rounded-full` mirrors the pill silhouette.

'use client';

import { X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

interface AlertsTextQueryInputProps {
  initialValue?: string;
  // The path the input's URL write targets. Defaults to `/alerts`
  // (the page that ships this primitive); the per-host detail page
  // passes `/assets/<host>` so the text-query state round-trips on
  // the same filter band shape rather than forcing a re-mount of a
  // per-page component. The chip-row + filter band remain byte-
  // identical — only the URL writer's destination changes.
  basePath?: string;
  inputId?: string;
  label?: string;
  placeholder?: string;
  clearLabel?: string;
  queryKey?: 'q' | 'hostname';
  preserveSelection?: boolean;
}

const DEBOUNCE_MS = 200;

export function AlertsTextQueryInput({
  initialValue = '',
  basePath = '/alerts',
  inputId = 'alerts-text-query-input',
  label = 'Search alerts by CVE id, asset hostname, or vulnerability title',
  placeholder = 'Search CVE, hostname, or title…',
  clearLabel = 'Clear search',
  queryKey = 'q',
  preserveSelection = false,
}: AlertsTextQueryInputProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `text` is the local-typed draft. URL state is the source of truth
  // for the rest of the page — we NEVER mirror it back to `text`.
  const [text, setText] = useState<string>(() => initialValue || searchParams.get(queryKey) || '');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push into the URL after a 200ms idle. The writer reads the current
  // browser URL (which includes any chip-state keys the page set),
  // mutates only `q`, and writes back. Reading at write time prevents
  // this debounce from overwriting a newer chip selection.
  //
  // Selection strip: any text-query keystroke (including clearing the
  // field via the clear button) is a view change, so `?selected=` is
  // dropped here. The page's `viewKey` useEffect mirrors this on its
  // side (drops the working set in memory) so the cleared-state path
  // is consistent at both layers. Stripping here also closes the
  // 200ms-debounce window during which the URL would otherwise carry
  // a stale `?selected=` with the new `?q=`.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        params.set(queryKey, trimmed);
      } else {
        params.delete(queryKey);
      }
      if (!preserveSelection) params.delete('selected');
      const qs = params.toString();
      const nextUrl = `${basePath}${qs ? `?${qs}` : ''}`;
      if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
        router.replace(nextUrl, { scroll: false });
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [text, router, basePath, preserveSelection, queryKey]);

  const onChange = useCallback((next: string) => {
    setText(next);
  }, []);

  const onClear = useCallback(() => {
    setText('');
  }, []);

  return (
    <label
      htmlFor={inputId}
      className="flex flex-1 min-w-[16rem] items-center gap-2 min-h-11 rounded-full border border-input bg-transparent px-4 md:min-h-0 md:px-3 cursor-text"
    >
      <span className="sr-only">{label}</span>
      <input
        id={inputId}
        type="search"
        value={text}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
      {text.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClear}
          aria-label={clearLabel}
          aria-controls={inputId}
          className="shrink-0 rounded-full"
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </label>
  );
}
