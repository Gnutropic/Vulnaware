// @polsia:user-owned — Recent activity feed for the post-login
// /dashboard. Reads GET /api/dashboard/recent-activity via apiFetch
// + the `DashboardRecentActivity` schema, renders up to 8 lifecycle
// events from the last 7 days across the team.
//
// Mirrors the chrome + a11y + data-testid discipline of
// `src/components/dashboard/alert-activity-card.tsx` (loading via
// `<Loader2>`, error copy as `<p role="alert">`, left-rail dot,
// mono timestamp, actor label, optional reason).
//
// Loading / error / empty posture:
//   - Loading  : `<Loader2>` spinner + "Loading activity…".
//   - Error    : `<p role="alert">` + soft-fail copy "Couldn't load
//                activity. The stats tiles above are unaffected.".
//                Stats row is independently fetched so this branch
//                never throws the whole page.
//   - Empty    : "No activity recorded yet." (true zero — a brand-new
//                team has no events).
//   - Success  : ordered list with kind chip (New / Resolved /
//                Reopened) on each row, anchor link → the alert
//                detail (`/alerts/${event.alertId}`).
//
// Each row's kind chip carries the badge variant secondary so the row
// reads as a timeline, not a tagged-by-color card. The label is the
// canonical verb ("New" / "Resolved" / "Reopened") not the
// discriminator literal so future `.kind` widening stays out of the
// UI's copy.

'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-client';
import {
  type DashboardActivityItem as DashboardActivityItemType,
  DashboardRecentActivity as DashboardRecentActivitySchema,
} from '@/lib/contracts/dashboard';

const KIND_LABEL: Record<DashboardActivityItemType['kind'], string> = {
  created: 'New',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

function formatTimestamp(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function DashboardRecentActivity(): ReactNode {
  const [items, setItems] = useState<DashboardActivityItemType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetch('/api/dashboard/recent-activity', { schema: DashboardRecentActivitySchema })
      .then((payload) => {
        if (!active) return;
        setItems(payload.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // Soft-fail — the card renders an inert branch so the page
        // still works. The stats tiles above are independently
        // fetched and unaffected by this branch.
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <DashboardCard title="Recent activity" description="Lifecycle events from the last 7 days.">
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading activity…
        </div>
      ) : error ? (
        <p
          role="alert"
          className="max-w-prose text-body text-muted-foreground"
          data-testid="dashboard-recent-activity-error"
        >
          Couldn’t load activity. The stats tiles above are unaffected.
        </p>
      ) : items.length === 0 ? (
        <p className="max-w-prose text-body text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <ol
          className="flex flex-col gap-3"
          aria-label="Recent dashboard activity"
          data-testid="dashboard-recent-activity-timeline"
        >
          {items.map((event) => (
            <DashboardActivityRow
              key={`${event.kind}-${event.at}-${event.alertId}`}
              event={event}
            />
          ))}
        </ol>
      )}
    </DashboardCard>
  );
}

// Inner row component. Split out so the parent stays focused on
// fetch + state, and the discriminator switch stays readable.
function DashboardActivityRow({ event }: { event: DashboardActivityItemType }): ReactNode {
  // Each event links into the alert detail page. The title cell is
  // the row's primary anchor; the rest of the row is metadata.
  const href = `/alerts/${event.alertId}`;
  return (
    <li
      className="relative flex gap-3 rounded-md border border-border/60 bg-muted/30 px-4 py-3"
      data-testid="dashboard-recent-activity-event"
    >
      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{KIND_LABEL[event.kind]}</Badge>
          <Link
            href={href}
            className="truncate font-mono text-caption text-foreground underline-offset-4 hover:underline"
            data-testid="dashboard-recent-activity-title"
          >
            {event.alertTitle}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
          <span className="font-mono">{formatTimestamp(event.at)}</span>
          {event.kind !== 'created' ? (
            <>
              <span aria-hidden>·</span>
              <span data-testid="dashboard-recent-activity-actor">
                {event.actorName ?? (event.actorId ? 'Unknown actor' : 'Unknown actor')}
              </span>
            </>
          ) : (
            <span data-testid="dashboard-recent-activity-actor">System ingested</span>
          )}
        </div>
        {event.reason ? (
          <p
            className="max-w-prose text-body text-foreground"
            data-testid="dashboard-recent-activity-reason"
          >
            {event.reason}
          </p>
        ) : null}
      </div>
    </li>
  );
}
