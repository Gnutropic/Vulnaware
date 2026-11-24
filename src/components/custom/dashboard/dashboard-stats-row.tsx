// @polsia:user-owned — 4-tile stat row for the post-login /dashboard.
//
// Reads GET /api/dashboard/summary via apiFetch + the `DashboardSummary`
// schema. Renders four `<DashboardCard>` tiles (Unresolved alerts / Owned by me /
// Snoozed / Resolved this week) inside a 4-column responsive grid,
// with a trailing "View all alerts" CTA that links into the inner
// /alerts surface.
//
// Loading / error / empty posture matches the project standard
// (see nextjs-data-plane SKILL.md):
//   - Loading  : per-tile `<Skeleton>` so the row never flashes an
//                authoritative "0" mid-fetch (counts can legitimately
//                be 0 on a brand-new team).
//   - Error    : per-tile inert "—" placeholder + a single inline
//                `<p role="alert">` copy; the row never throws.
//   - Success  : tile body = `<p className="text-display ...">{count}</p>`.

'use client';

import { ArrowRight, Bell, BellOff, CheckCheck, UserCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { DashboardSummary } from '@/lib/contracts/dashboard';

const ACTIVE_WORKSPACE_CHANGED_EVENT = 'active-workspace-changed';

interface Tile {
  key: keyof SummaryState;
  title: string;
  description: string;
  icon: ReactNode;
}

interface SummaryState {
  open: number;
  ownedByMe: number;
  snoozed: number;
  resolvedThisWeek: number;
}

const TILES: Tile[] = [
  {
    key: 'open',
    title: 'Unresolved alerts',
    description: 'Open and in-progress alerts, including snoozed rows.',
    icon: <Bell aria-hidden="true" className="size-4 text-muted-foreground" />,
  },
  {
    key: 'ownedByMe',
    title: 'Owned by me',
    description: 'Across every state — open, in-progress, and resolved.',
    icon: <UserCheck aria-hidden="true" className="size-4 text-muted-foreground" />,
  },
  {
    key: 'snoozed',
    title: 'Snoozed',
    description: 'Silenced with an active snooze window.',
    icon: <BellOff aria-hidden="true" className="size-4 text-muted-foreground" />,
  },
  {
    key: 'resolvedThisWeek',
    title: 'Resolved this week',
    description: 'Closed in the last 7 days.',
    icon: <CheckCheck aria-hidden="true" className="size-4 text-muted-foreground" />,
  },
];

export function DashboardStatsRow(): ReactNode {
  const [state, setState] = useState<SummaryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const loadSummary = () => {
      const currentRequestId = ++requestId;
      setLoading(true);
      setError(null);
      setState(null);
      apiFetch('/api/dashboard/summary', { schema: DashboardSummary })
        .then((payload) => {
          if (!active || currentRequestId !== requestId) return;
          setState(payload);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!active || currentRequestId !== requestId) return;
          // Soft-fail — the row renders inert placeholders so the
          // page still works. The activity card below the row is
          // independent and untouched by this branch.
          const msg = err instanceof Error ? err.message : 'Unknown error';
          setError(msg);
          setLoading(false);
        });
    };

    loadSummary();
    window.addEventListener(ACTIVE_WORKSPACE_CHANGED_EVENT, loadSummary);

    return () => {
      active = false;
      window.removeEventListener(ACTIVE_WORKSPACE_CHANGED_EVENT, loadSummary);
    };
  }, []);

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="dashboard-stats-row">
      {TILES.map((tile) => (
        <DashboardCard
          key={tile.key}
          title={tile.title}
          description={tile.description}
          action={tile.icon}
        >
          {loading ? (
            <Skeleton className="h-10 w-2/3" aria-hidden="true" />
          ) : state ? (
            <>
              <p className="font-display text-h3 leading-none tracking-tight text-foreground">
                {state[tile.key].toLocaleString()}
              </p>
              {tile.key === 'open' && state.open === 0 ? (
                <p className="mt-2 text-caption text-muted-foreground">No unresolved alerts</p>
              ) : null}
            </>
          ) : (
            <p role="alert" className="text-caption text-muted-foreground">
              —
            </p>
          )}
        </DashboardCard>
      ))}
      {error ? (
        <p
          role="alert"
          className="col-span-full max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-stats-row-error"
        >
          Couldn’t load alerts summary. The activity timeline below is unaffected.
        </p>
      ) : (
        <div className="col-span-full flex justify-end">
          <Button asChild variant="link" size="sm">
            <Link href="/alerts" className="gap-1.5">
              View all alerts
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}
