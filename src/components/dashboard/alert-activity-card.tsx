// @polsia:user-owned — Per-alert lifecycle timeline client island.
// Reads GET /api/alerts/[id]/activity via apiFetch + the
// `AlertActivityList` schema, renders the timeline vertically with
// a left rail dot per event, an "at" timestamp + an "actor" label +
// the reason body. Empty state fires when the row has never
// transitioned (no reopen events stamped); loading + error states
// follow the project's standard `<p role="alert">` + `<p>Loading…</p>`
// pattern from nextjs-data-plane/SKILL.md.
//
// Why a dedicated island rather than inline in alert-detail-client.tsx:
//   - The list and detail islands already split data-fetch
//     responsibility per `/api` resource; adding the activity feed
//     inline would force the detail envelope to re-fetch on every
//     state mutation just to refresh the timeline. The activity
//     feed re-fires via its own `onReopened` handle from the parent
//     detail island so the activity list and the alert chip
//     stay in lockstep without coupling their fetches.
//   - The timeline is fundamentally a per-row introspection surface;
//     isolating it here keeps the parent detail island focused on
//     the envelope + owner + triage actions.
//
// Event kinds: today only `id: 'reopen'` is emitted by the route —
// a literal-union widening here is the future expansion knob. The
// rendering branch keys off `event.id` so a new kind (e.g.
// `id: 'resolve'`) renders its own row shape without rebuilding
// the surrounding timeline chrome.

'use client';

import { History, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { AlertActivityList } from '@/lib/contracts/alerts';

interface AlertActivityCardProps {
  alertId: string;
  // Server-stamped "most recent activity" stamp =
  // MAX(remediatedAt, MAX(AlertNote.createdAt)) per alert. Mounted
  // on the parent detail island (props pass-through from the
  // `AlertDetail` envelope) so the activity sidebar subtitle mirrors
  // the "Last activity" column on /alerts without a second round
  // trip. Null when BOTH inputs are null (the row has never been
  // remediated AND has no handoff notes).
  lastActivityAt?: string | null;
}

// 60-second tick keeps the subtitle's relative age visibly fresh
// inside the open tab. Mirror of alert-notes-card.tsx +
// alert-comments-card.tsx + alerts-list-cards.tsx.
const RELATIVE_TICK_MS = 60_000;

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function formatRelative(value: string, now: number): string {
  const d = new Date(value);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return '—';
  const deltaSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 45) return RTF.format(deltaSec, 'second');
  if (abs < 45 * 60) return RTF.format(Math.round(deltaSec / 60), 'minute');
  if (abs < 22 * 60 * 60) return RTF.format(Math.round(deltaSec / 3600), 'hour');
  if (abs < 26 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / 86_400), 'day');
  if (abs < 320 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / (7 * 86_400)), 'week');
  if (abs < 365 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / (30 * 86_400)), 'month');
  return RTF.format(Math.round(deltaSec / (365 * 86_400)), 'year');
}

export function AlertActivityCard({ alertId, lastActivityAt = null }: AlertActivityCardProps) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());
    }, RELATIVE_TICK_MS);
    return () => {
      clearInterval(handle);
    };
  }, []);
  const [items, setItems] = useState<
    Array<{
      id: 'reopen';
      at: string;
      actorId: string | null;
      actorName: string | null;
      reason: string | null;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetch(`/api/alerts/${alertId}/activity`, { schema: AlertActivityList })
      .then((payload) => {
        if (!active) return;
        setItems(payload.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Soft-fail — the card renders an "unavailable" branch so
        // the page still works. The activity feed is a per-row
        // introspection surface, NOT load-bearing.
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [alertId]);

  return (
    <Card className="border-border/80 bg-card shadow-sm" data-testid="alert-activity-card">
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Lifecycle
        </CardDescription>
        <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
          <History className="size-4 text-brand-500" aria-hidden />
          Alert activity
        </CardTitle>
        {/* Last-activity subtitle — mirrors the `Last activity` column
            on /alerts. Renders ONLY when the server-stamped stamp is
            present; absent when the row has neither a remediation nor
            any handoff notes so the existing "Re-open events on this
            alert roll up here…" copy below stays unchanged. */}
        {lastActivityAt ? (
          <CardDescription
            className="text-caption text-muted-foreground"
            data-testid="alert-activity-last-activity"
          >
            Last activity: <span title={lastActivityAt}>{formatRelative(lastActivityAt, now)}</span>
          </CardDescription>
        ) : null}
        <CardDescription className="text-caption text-muted-foreground">
          Re-open events on this alert roll up here so the operator can scan the lifecycle in one
          place.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading activity…
          </div>
        ) : error ? (
          <p role="alert" className="max-w-prose text-body text-muted-foreground">
            Couldn’t load activity for this alert. The detail metadata above is unaffected.
          </p>
        ) : items.length === 0 ? (
          <p className="max-w-prose text-body text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ol
            className="flex flex-col gap-3"
            aria-label="Alert lifecycle events"
            data-testid="alert-activity-timeline"
          >
            {items.map((event) => (
              <li
                key={`${event.id}-${event.at}`}
                className="relative flex gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
              >
                <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />
                <div className="flex flex-col gap-1">
                  <p className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                    {event.id === 'reopen' ? 'Reopened' : event.id}
                  </p>
                  <p className="font-mono text-caption text-foreground">
                    {formatTimestamp(event.at)}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {event.actorName ?? (event.actorId ? 'Unknown actor' : 'Unknown actor')}
                  </p>
                  {event.reason ? (
                    <p
                      className="max-w-prose text-body text-foreground"
                      data-testid="alert-activity-reason"
                    >
                      {event.reason}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function formatTimestamp(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
