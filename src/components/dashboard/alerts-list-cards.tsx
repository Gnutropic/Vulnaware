// @polsia:user-owned — Mobile (< md) stacked-card view of the alerts list.
// Sister surface to <Table> in src/app/(dashboard)/alerts/page.tsx; renders
// the same `AlertItem[]` so the desktop table and the mobile cards stay
// in lockstep with a single fetch. Render-only aside from the per-row
// Reopen click — gates server-side by `item.status === 'resolved'` so a
// card only carries the control when a reopen is meaningful. The Reopen
// gesture is delegated to the parent's `onReopened(id)` (which owns the
// POST + optimistic state flip) so the mobile + desktop surfaces stay
// in lockstep on a single source of truth. `pendingReopenId` is read
// from a parent-managed prop so the spinner state matches the row the
// parent is currently POSTing. `hidden md:hidden` keeps the cards out of
// the desktop layout; the page toggles whichever surface it needs.
//
// Selection model: `selectedIds` is a Set<string> mirroring the page
// state's working set; `onToggle(id)` flips an id in/out of the set
// and the page's `effectiveQs` writer mirrors it into the URL. The
// Radix Checkbox carries `data-state` (`checked` / `unchecked`) directly
// so the bulk-resolve test contract (look up row state via data-state)
// works unchanged across both breakpoints.

'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CommentsCountBadge } from '@/components/custom/alerts/comments-count-badge';
import { TrendingBadge } from '@/components/custom/alerts/trending-badge';
import { AlertAge, formatAlertCreatedAt } from '@/components/dashboard/alert-age';
import { AlertsListStatus } from '@/components/dashboard/alerts-list-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { buildAlertDetailHref } from '@/lib/business/alerts-navigation';
import type { AlertItem, AlertStatusMutationResponse } from '@/lib/contracts/alerts';
import { scanSourceLabels } from '@/lib/scan-source-labels';

function severityVariant(sev: string | null): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}

function sourceVariant(
  source: 'kev' | 'vulncheck' | 'manual',
): 'destructive' | 'secondary' | 'outline' {
  if (source === 'kev') return 'destructive';
  if (source === 'manual') return 'outline';
  return 'secondary';
}

// 60-second tick keeps mobile-card relative ages from going stale
// without a refetch — mirror of alert-notes-card.tsx +
// alert-comments-card.tsx. Cheap; cleans up on unmount.
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

export interface AlertsListCardsProps {
  items: AlertItem[];
  detailQueryString?: string;
  // Id of the row whose resolve POST is currently in flight. The card
  // for that row renders the spinner state while the parent owns the
  // request and list-state update.
  pendingResolveId?: string | null;
  // Fires when the user clicks Resolve on a row. Parent owns the POST
  // and the state update so mobile and desktop share one mutation path.
  onResolve?: (id: string) => void | Promise<void>;
  // Id of the row whose reopen POST is currently in flight. The card
  // for that row renders the spinner state; all other resolved rows
  // stay clickable.
  pendingReopenId?: string | null;
  // Fires when the user clicks Reopen on a given row. Parent owns the
  // POST + the optimistic state flip on `data.items` so the export
  // anchor (which reads `effectiveQs`) and the row chip stay aligned
  // with the server-returned envelope.
  onReopened?: (id: string) => void | Promise<void>;
  // Id of the row whose false-positive POST is currently in flight.
  // The card for that row renders the spinner state so a stale
  // double-click on the row's Mark false positive button can't fire
  // a second fan-out. Symmetric to `pendingReopenId`.
  pendingFalsePositiveId?: string | null;
  // Fires when the user clicks "Mark false positive" on a given row.
  // Parent owns the dialog open + the POST + the optimistic flip —
  // this component is a presentational leaf that only emits the
  // intent. Already-FP rows don't show the button (no transition
  // out of the FP branch from this surface; the detail page is
  // where Reopen-from-FP lives).
  onFalsePositive?: (id: string) => void;
  // Working-set membership — passed down from the page's selection
  // state. The page mirrors the set into the URL `?selected=` so a
  // reload preserves it; this component is purely presentational +
  // an id-emit through `onToggle`.
  selectedIds?: Set<string>;
  // Fired when the operator toggles a row's checkbox. Parent flips
  // membership in the working set + mirrors into the URL.
  onToggle?: (id: string) => void;
  // Parent reconciles the matching list item from the mutation response
  // so the desktop table and mobile cards share the same saved state.
  onStatusSaved?: (saved: AlertStatusMutationResponse) => void;
  // Contextual copy shared with the desktop table when the active
  // filters return no authorized alerts.
  emptyStateMessage?: string;
}

export function AlertsListCards({
  items,
  detailQueryString = '',
  pendingResolveId = null,
  onResolve,
  pendingReopenId = null,
  onReopened,
  pendingFalsePositiveId = null,
  onFalsePositive,
  selectedIds,
  onToggle,
  onStatusSaved,
  emptyStateMessage = 'No alerts yet.',
}: AlertsListCardsProps) {
  // Relative-time base for the "Last activity" pill. Mirrors the
  // page-side `now` state. The helper's two-arm resolver
  // (`noteMax OR remediatedAt`) now returns `null` for a row with
  // neither; the card renders the em-dash placeholder for that
  // branch (the parent's `data.items` may ship a brand-new row with
  // no handoff notes AND no remediation stamp).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());
    }, RELATIVE_TICK_MS);
    return () => {
      clearInterval(handle);
    };
  }, []);

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-6 text-center text-body text-muted-foreground">
        {emptyStateMessage}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const isSelected = selectedIds?.has(item.id) ?? false;
        return (
          <li
            key={item.id}
            className={
              isSelected
                ? 'flex flex-col gap-3 rounded-lg border border-primary bg-card p-3 shadow-sm ring-1 ring-primary/30'
                : 'flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-sm'
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {/* Per-card checkbox — drives the bulk-resolve working
                  set. Radix hosts `data-state` directly on the root,
                  so the test contract (find-by-data-state) reads the
                  same in both the desktop table and the mobile card. */}
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onToggle?.(item.id)}
                aria-label={`Select alert ${item.id}`}
              />
              <Badge
                variant={severityVariant(item.severity)}
                className="font-mono uppercase tracking-wider"
              >
                {item.severity ?? 'unknown'}
              </Badge>
              <Badge
                variant={sourceVariant(item.source)}
                className="font-mono uppercase tracking-wider"
              >
                {item.source === 'kev' ? 'KEV' : item.source === 'manual' ? 'Manual' : 'VulnCheck'}
              </Badge>
              {item.snoozedUntil ? (
                <Badge
                  variant="outline"
                  className="font-mono text-caption"
                  title={`Snoozed until ${new Date(item.snoozedUntil).toLocaleString()}`}
                >
                  Snoozed until {new Date(item.snoozedUntil).toLocaleString()}
                </Badge>
              ) : null}
              {/* Trending badge — server-stamped onto the row when the
                  CVE id is in the workspace's latest trend
                  acceleratingIncreases list. `asChild` makes the badge
                  itself the link; mirrors the desktop row stack so
                  parity holds between breakpoints. */}
              {item.trending ? <TrendingBadge cveId={item.cveId} /> : null}
              {/* Comment count badge — server-stamped onto the row from the
                  alertComment.groupBy peer-read in /api/alerts. The badge IS
                  the link to the detail thread via Badge `asChild` →
                  next/link, mirroring the Trending badge pattern.
                  `> 0` gate keeps the mobile stack clean for alerts with
                  no thread yet. Mobile parity with the desktop row stack
                  so a `/alerts/[id]` pointer reads the same in both
                  layouts. */}
              {item.commentCount && item.commentCount > 0 ? (
                <CommentsCountBadge
                  count={item.commentCount}
                  alertId={item.id}
                  detailQueryString={detailQueryString}
                />
              ) : null}
              {item.remediatedAt ? (
                <Badge
                  variant="outline"
                  className="font-mono text-caption text-brand-600"
                  title={`Remediated at ${new Date(item.remediatedAt).toLocaleString()}`}
                >
                  Remediated
                </Badge>
              ) : null}
              {item.status === 'resolved' ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-caption"
                  data-testid="alert-resolved-badge"
                >
                  Resolved
                </Badge>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              {item.cveId ? (
                <a
                  href={`https://nvd.nist.gov/vuln/detail/${item.cveId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-body text-foreground underline-offset-2 hover:underline"
                >
                  {item.cveId}
                </a>
              ) : (
                <span className="font-mono text-muted-foreground">—</span>
              )}
              {item.asset.host ? (
                <span className="flex flex-col gap-0.5 break-all font-mono text-caption text-muted-foreground">
                  <span>
                    {item.asset.detailHref ? (
                      <Button
                        asChild
                        variant="link"
                        size="sm"
                        className="h-auto px-0 font-mono text-caption"
                      >
                        <Link href={item.asset.detailHref}>{item.asset.host}</Link>
                      </Button>
                    ) : (
                      item.asset.host
                    )}
                    :{item.asset.port}/{item.asset.protocol}
                  </span>
                  {item.asset.riskScore != null && Number.isFinite(item.asset.riskScore) ? (
                    <span>Risk {item.asset.riskScore.toFixed(2)} /10</span>
                  ) : null}
                </span>
              ) : (
                <span className="break-all font-mono text-caption text-muted-foreground">—</span>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="outline" className="font-mono text-caption">
                Triggered by {scanSourceLabels[item.triggeredBy ?? 'manual']}
              </Badge>
              <div className="flex flex-col items-end gap-0.5 text-caption text-muted-foreground">
                <span>
                  Alert age: <AlertAge createdAt={item.createdAt} now={now} />
                </span>
                <span>{formatAlertCreatedAt(item.createdAt) ?? 'Unknown'}</span>
                <span>
                  Last activity:{' '}
                  {item.lastActivityAt ? (
                    <span title={item.lastActivityAt}>
                      {formatRelative(item.lastActivityAt, now)}
                    </span>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            </div>

            {onStatusSaved ? (
              <div className="rounded-md border border-border/70 bg-muted/20 p-3">
                <AlertsListStatus item={item} onSaved={onStatusSaved} />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="link" size="sm" className="-ml-3 min-h-11 md:min-h-0">
                <Link href={buildAlertDetailHref(item.id, detailQueryString)}>View details</Link>
              </Button>
              {item.status !== 'resolved' && item.status !== 'false_positive' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void onResolve?.(item.id)}
                  disabled={pendingResolveId === item.id}
                  aria-disabled={pendingResolveId === item.id}
                  className="min-h-11 md:min-h-0"
                >
                  {pendingResolveId === item.id ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Resolving…
                    </>
                  ) : (
                    'Resolve'
                  )}
                </Button>
              ) : null}
              {item.status === 'resolved' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void onReopened?.(item.id)}
                  disabled={pendingReopenId === item.id}
                  aria-disabled={pendingReopenId === item.id}
                  className="min-h-11 md:min-h-0"
                >
                  {pendingReopenId === item.id ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Reopening…
                    </>
                  ) : (
                    'Reopen'
                  )}
                </Button>
              ) : null}
              {item.status !== 'false_positive' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onFalsePositive?.(item.id)}
                  disabled={pendingFalsePositiveId === item.id}
                  aria-disabled={pendingFalsePositiveId === item.id}
                  className="min-h-11 md:min-h-0"
                >
                  {pendingFalsePositiveId === item.id ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Marking…
                    </>
                  ) : (
                    'Mark false positive'
                  )}
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
