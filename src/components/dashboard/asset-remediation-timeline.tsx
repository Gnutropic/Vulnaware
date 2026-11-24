// @polsia:user-owned — Remediation timeline island for
// /assets/[host]. Reads `RemediationTimeline` via apiFetch from
// `/api/assets/<host>/remediation-timeline`.
//
// Renders:
//   - Card chrome matching /assets/<host> (border-border/80
//     bg-card shadow-sm), with an icon + heading + caption.
//   - A horizontally-laid axis with severity-colored dots positioned
//     by `(resolvedAt - rangeStart) / (rangeEnd - rangeStart)`.
//   - A month-and-week tick rule below the axis (months as longer
//     ticks, weeks as shorter). Generated client-side from the
//     rangeStart+rangEnd stamps — no second /api round-trip needed.
//   - Each dot is wrapped in a Radix Tooltip showing title + CVE id +
//     severity + resolvedAt + source discriminator. Tooltip shows on
//     hover/focus so a mobile tap opens the spotlight, and a tap on
//     the dot deep-links to `/alerts/<alertId>` so keyboard users
//     have a discoverable drill-down.
//   - Empty state: a centered "No remediations yet" message + a
//     hint pointing at the alerts list above. NO "scan again" CTA
//     because re-scanning is a separate flow.
//   - Error state: <p role="alert"> per the project pattern.
//
// No new dependencies. Uses existing shadcn primitives (Card,
// Badge, Tooltip, Skeleton) plus a small inline SVG for the axis
// ruler when positioning precision beats CSS calc.

// 'use client' kept inside the comment per the project's posture:
// the runtime directive is set on line N (see below) so Biome and
// the route layer both see it without ambiguity. The header
// comment above is the design contract.

'use client';

import { Clock3, History, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch } from '@/lib/api-client';
import {
  RemediationTimeline,
  type RemediationTimeline as RemediationTimelineData,
} from '@/lib/contracts/assets-remediation';

interface AssetRemediationTimelineProps {
  host: string;
}

// Severity → dot fill class. The token-backed colors mirror the
// per-row `severityVariant` palette from
// src/components/dashboard/asset-detail-client.tsx:95-100 so the
// dots and the alert-row severity badges read in lockstep.
function severityDotClass(sev: string | null | undefined): string {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'bg-destructive';
  if (s === 'medium') return 'bg-secondary-foreground';
  if (s === 'low') return 'bg-muted-foreground';
  return 'bg-muted-foreground';
}

// Severity → Badge variant. Mirrors `severityVariant` at
// asset-detail-client.tsx:95. Three buckets because the underlying
// Badge variants destructure to exactly: `destructive | secondary
// | outline`.
function severityBadgeVariant(
  sev: string | null | undefined,
): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

function formatLongDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

// Generate month boundaries between two ISO stamps. Used to render
// the axis ruler labels. Months are longer ticks; weeks are
// shorter ticks (between two adjacent month markers, the week
// boundaries are computed inline in the axis render).
function buildMonthMarks(rangeStart: string, rangeEnd: string): Array<{ at: Date; label: string }> {
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out: Array<{ at: Date; label: string }> = [];
  // Anchor the cursor on the FIRST of the start-month so the
  // mutation-only `setMonth(+1)` below never overshoots.
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  // Cap iterations on month count so a misformatted ISO stamp can't
  // loop indefinitely on pathological inputs.
  let iter = 0;
  while (cursor <= end && iter < 240) {
    out.push({
      at: new Date(cursor.getTime()),
      label: cursor.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
      }),
    });
    cursor.setMonth(cursor.getMonth() + 1);
    iter += 1;
  }
  return out;
}

// Position a date between [start, end] as a 0–1 percentage. Clamps
// to [0,1] so a single outlier doesn't push a dot off the axis.
function positionAt(date: Date, start: Date, end: Date): number {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 0;
  const ratio = (date.getTime() - start.getTime()) / span;
  return Math.min(1, Math.max(0, ratio));
}

export function AssetRemediationTimeline({ host }: AssetRemediationTimelineProps) {
  const [data, setData] = useState<RemediationTimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mount-keyed on `host` so a navigation between
  // `/assets/<host-A>` and `/assets/<host-B>` re-fires. Chipping
  // chip-rows on the same page does NOT re-fire this fetch — the
  // timeline envelope is host-scoped only and the chip filter
  // family on /assets/[host] does NOT change the host.
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    apiFetch(`/api/assets/${encodeURIComponent(host)}/remediation-timeline`, {
      schema: RemediationTimeline,
    })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
      });
    return () => {
      active = false;
    };
  }, [host]);

  const rangeStart = data?.rangeStart ?? null;
  const rangeEnd = data?.rangeEnd ?? null;
  const events = data?.events ?? [];

  const monthMarks = useMemo(
    () => (rangeStart && rangeEnd ? buildMonthMarks(rangeStart, rangeEnd) : []),
    [rangeStart, rangeEnd],
  );

  // Stack multiple events that resolve on the same day so dots
  // overlap visibly rather than stacking into a single bright blob.
  // The map is keyed on the resolvedAt epoch-ms (collapsed to
  // day-resolution) so co-day events stay grouped; each group
  // offsets its dots by ±N pixels below the axis.
  const eventStrips = useMemo(() => {
    if (!rangeStart || !rangeEnd) return [];
    const start = new Date(rangeStart);
    const end = new Date(rangeEnd);
    const groups = new Map<string, Array<{ event: (typeof events)[number]; pct: number }>>();
    for (const ev of events) {
      const d = new Date(ev.resolvedAt);
      if (Number.isNaN(d.getTime())) continue;
      const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const group = groups.get(day) ?? [];
      group.push({ event: ev, pct: positionAt(d, start, end) });
      groups.set(day, group);
    }
    const strips: Array<Array<{ event: (typeof events)[number]; pct: number; offsetPx: number }>> =
      [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.pct - b.pct);
      // Stack offsets in 8px steps. Max 6 visible tiers — a deeper
      // stack collapses to a +N badge tooltip.
      const rowSize = 8;
      const maxRows = 6;
      group.forEach((entry, idx) => {
        const row = Math.floor(idx / 1);
        const offsetPx = Math.min(row, maxRows - 1) * rowSize;
        const stripIdx = 0;
        if (!strips[stripIdx]) strips[stripIdx] = [];
        strips[stripIdx].push({ event: entry.event, pct: entry.pct, offsetPx });
      });
    }
    return strips;
  }, [events, rangeStart, rangeEnd]);

  if (error) {
    return (
      <Card
        className="border-border/80 bg-card shadow-sm"
        data-testid="asset-remediation-timeline-error"
      >
        <CardHeader className="space-y-2">
          <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
            Remediation timeline
          </CardDescription>
          <CardTitle className="flex items-center gap-2 text-h3 tracking-tight text-foreground">
            <History className="size-5 text-brand-500" aria-hidden />
            Remediation timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="max-w-prose text-body text-muted-foreground">
            Couldn’t load the remediation timeline for this host. The alerts list above is
            unaffected.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return <AssetRemediationTimelineSkeleton />;
  }

  if (events.length === 0 || !rangeStart || !rangeEnd) {
    return <AssetRemediationTimelineEmpty host={host} />;
  }

  return (
    <Card className="border-border/80 bg-card shadow-sm" data-testid="asset-remediation-timeline">
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Remediation timeline
        </CardDescription>
        <CardTitle className="flex items-center gap-2 font-display text-h3 tracking-tight text-foreground">
          <Clock3 className="size-5 text-brand-500" aria-hidden />
          Remediation timeline
        </CardTitle>
        <CardDescription className="text-caption text-muted-foreground">
          {events.length} {events.length === 1 ? 'remediated event' : 'remediated events'} on{' '}
          <span className="font-mono">{host}</span> between {formatDate(rangeStart)} and{' '}
          {formatDate(rangeEnd)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TimelineAxis
          host={host}
          events={events}
          monthMarks={monthMarks}
          eventStrips={eventStrips}
        />
      </CardContent>
    </Card>
  );
}

function TimelineAxis({
  host,
  events,
  monthMarks,
  eventStrips,
}: {
  host: string;
  events: RemediationTimelineData['events'];
  monthMarks: Array<{ at: Date; label: string }>;
  eventStrips: Array<
    Array<{ event: RemediationTimelineData['events'][number]; pct: number; offsetPx: number }>
  >;
}) {
  // Pure-HTML positioning: a relative container sized to the full
  // width, an absolutely-positioned baseline rule, and absolutely-
  // positioned dot triggers stacked top-of-axis. Co-day events
  // offset vertically in 8px steps so taps don't overlap. Each
  // dot is a Radix <Tooltip> wrapped <Link> deep-linking to the
  // per-alert page so keyboard users have a discoverable drill-down.
  return (
    <div
      className="relative flex h-28 w-full flex-col"
      role="img"
      aria-label={`${host} remediation timeline, ${events.length} ${events.length === 1 ? 'event' : 'events'}`}
      data-testid="asset-remediation-timeline-axis"
    >
      {/* Dots row — anchored at top so the vertical stack of co-day
          events lands inside the same column. Tab-stoppable <button>
          via the Link-as-tooltip-trigger pattern below. */}
      <div className="absolute inset-x-0 top-2 bottom-7">
        {eventStrips.flat().map(({ event, pct, offsetPx }, idx) => {
          const sevLabel = event.severity ? event.severity : 'unknown severity';
          const isRemediated = event.source === 'remediated';
          const dotClass = severityDotClass(event.severity);
          return (
            <Tooltip key={`${event.alertId}-${event.source}-${idx}`}>
              <TooltipTrigger asChild>
                <Link
                  href={`/alerts/${event.alertId}`}
                  type="button"
                  aria-label={`Alert ${event.cveId.length > 0 ? event.cveId : event.alertId} — ${sevLabel} (${isRemediated ? 'Remediated' : 'Resolved'}) on ${formatDate(event.resolvedAt)}`}
                  className={`absolute block size-3 -translate-x-1/2 rounded-full ring-2 ring-background ${dotClass}`}
                  style={{ left: `${pct * 100}%`, top: `${offsetPx}px` }}
                >
                  <span className="sr-only">{`${sevLabel} ${event.cveId.length > 0 ? event.cveId : event.alertId}`}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top" align="center" className="max-w-xs">
                <div className="flex flex-col gap-1 text-xs">
                  <p className="font-mono text-[11px] uppercase tracking-wider opacity-80">
                    {isRemediated ? 'Remediated' : 'Resolved'}
                  </p>
                  <p className="font-semibold text-primary-foreground">
                    {event.cveTitle && event.cveTitle.trim().length > 0
                      ? event.cveTitle
                      : event.cveId.length > 0
                        ? event.cveId
                        : event.alertId}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {event.cveId ? (
                      <span className="font-mono">{event.cveId}</span>
                    ) : (
                      <span className="font-mono opacity-80">—</span>
                    )}
                    <Badge
                      variant={severityBadgeVariant(event.severity)}
                      className="font-mono uppercase tracking-wider"
                    >
                      {sevLabel}
                    </Badge>
                  </div>
                  <p className="text-primary-foreground/90">{formatLongDate(event.resolvedAt)}</p>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* Baseline rule — a single thin border-bottom under the
          dot row. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-7 border-t border-border/60" />

      {/* Month tick rule — months are longer marks. Week ticks
          between two adjacent month markers align on ISO-week
          boundaries. First/last mark lands flush with the left/
          right edge so the axis end is visually defined. */}
      <div className="absolute inset-x-0 bottom-0 flex h-6 items-end">
        {monthMarks.map((m, idx) => {
          const firstMonth = monthMarks[0];
          const lastMonth = monthMarks[monthMarks.length - 1];
          const isFirst =
            !!firstMonth &&
            firstMonth.at.getFullYear() === m.at.getFullYear() &&
            firstMonth.at.getMonth() === m.at.getMonth();
          const isLast =
            !!lastMonth &&
            monthMarks.length > 1 &&
            lastMonth.at.getFullYear() === m.at.getFullYear() &&
            lastMonth.at.getMonth() === m.at.getMonth();
          const span = monthMarks.length > 1 ? 100 / (monthMarks.length - 1) : 0;
          const leftPct = isFirst ? 0 : isLast ? 100 : idx * span;
          return (
            <div
              key={`m-${m.label}-${idx}`}
              className="absolute flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${leftPct}%` }}
            >
              <span className="block h-2 w-px bg-border/80" />
              <span
                className={`mt-1 font-mono text-[10px] text-muted-foreground ${
                  isFirst ? '-translate-x-0' : isLast ? 'translate-x-0' : ''
                }`}
                style={
                  isFirst
                    ? { transform: 'translateX(0)' }
                    : isLast
                      ? { transform: 'translateX(-100%)' }
                      : undefined
                }
              >
                {m.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssetRemediationTimelineEmpty({ host }: { host: string }) {
  return (
    <Card
      className="border-border/80 bg-card shadow-sm"
      data-testid="asset-remediation-timeline-empty"
    >
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Remediation timeline
        </CardDescription>
        <CardTitle className="flex items-center gap-2 font-display text-h3 tracking-tight text-foreground">
          <History className="size-5 text-brand-500" aria-hidden />
          Remediation timeline
        </CardTitle>
        <CardDescription className="text-caption text-muted-foreground">
          Chronological view of resolved and remediated alerts on this host.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="max-w-prose text-body text-foreground">No remediations yet.</p>
        <p className="max-w-prose text-body text-muted-foreground">
          Once an alert on <span className="font-mono">{host}</span> is resolved or remediated, it
          will appear here plotted against the resolution date.
        </p>
      </CardContent>
    </Card>
  );
}

function AssetRemediationTimelineSkeleton() {
  return (
    <Card
      className="border-border/80 bg-card shadow-sm"
      data-testid="asset-remediation-timeline-loading"
      aria-hidden="true"
    >
      <CardHeader className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-3 w-72" />
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading remediation timeline…
        </div>
        <Skeleton className="mt-3 h-28 w-full" />
      </CardContent>
    </Card>
  );
}
