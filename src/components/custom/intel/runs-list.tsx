// @polsia:user-owned — Competitive-intel audit runs list. Client
// island that fetches the listing via `apiFetch('/api/intel/runs')`,
// renders the rows newest-first, and lazy-loads the body of any
// expanded card through `/api/intel/runs/[id]`. Mirrors the
// expansion affordance used by `src/components/custom/report-view.tsx`.
//
// `body` is intentionally NOT in the list payload (see
// src/lib/contracts/intel.ts) — the click-to-expand call round-trips
// the full text on demand so the listing stays trim.

'use client';

import { ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  type IntelRunDetail,
  IntelRunDetail as IntelRunDetailSchema,
  IntelRunList,
  type IntelRunListItem,
} from '@/lib/contracts/intel';

type ExpandedMap = Record<string, { detail?: IntelRunDetail; loading: boolean; error?: string }>;

function formatDate(value: string): string {
  // value is ISO-8601 UTC; render the date plus time so two reports
  // from the same day remain distinguishable.
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return value;
  }
}

export function IntelRunsList() {
  const [items, setItems] = useState<IntelRunListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedMap>({});

  const reload = useCallback(async () => {
    setListError(null);
    try {
      const list = await apiFetch('/api/intel/runs', { schema: IntelRunList });
      setItems(list.items);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load reports');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleExpand = useCallback(async (item: IntelRunListItem) => {
    setExpanded((prev) => {
      const existing = prev[item.id];
      // Collapse-if-already-loaded branch.
      if (existing?.detail) {
        const next = { ...prev };
        delete next[item.id];
        return next;
      }
      return { ...prev, [item.id]: { ...(existing ?? {}), loading: true } };
    });
    try {
      const detail = await apiFetch(`/api/intel/runs/${item.id}`, {
        schema: IntelRunDetailSchema,
      });
      setExpanded((prev) => ({ ...prev, [item.id]: { detail, loading: false } }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load body';
      setExpanded((prev) => ({ ...prev, [item.id]: { loading: false, error: msg } }));
    }
  }, []);

  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading reports…
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {listError ? (
        <p className="text-caption text-destructive" role="alert">
          {listError}
        </p>
      ) : null}
      {items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-border bg-muted/30 px-4 py-8 text-caption text-muted-foreground">
          <Sparkles className="size-4" aria-hidden />
          <span>
            No audit reports yet — the nightly job locks in a fresh row per UTC day. Check back
            tomorrow morning.
          </span>
        </div>
      ) : (
        items.map((item) => {
          const row = expanded[item.id];
          const isOpen = Boolean(row?.detail);
          const isLoadingRow = Boolean(row?.loading);
          return (
            <article
              key={item.id}
              className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-sm"
            >
              <button
                type="button"
                onClick={() => void toggleExpand(item)}
                aria-expanded={isOpen}
                className="flex w-full items-start gap-3 border-b border-transparent px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {isOpen ? (
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-brand-500" aria-hidden />
                ) : (
                  <ChevronRight
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-mono text-caption uppercase tracking-wider text-muted-foreground">
                    {formatDate(item.ranAt)}
                  </p>
                  <p className="text-body font-medium text-foreground">{item.headline}</p>
                </div>
              </button>
              {isOpen ? (
                <div className="border-t border-border/60 bg-background px-5 py-4">
                  {isLoadingRow ? (
                    <div className="flex items-center gap-2 text-caption text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Loading report body…
                    </div>
                  ) : row?.error ? (
                    <p className="text-caption text-destructive" role="alert">
                      {row.error}
                    </p>
                  ) : row?.detail ? (
                    <p className="whitespace-pre-wrap font-mono text-small leading-relaxed text-foreground">
                      {row.detail.body}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </div>
  );
}
