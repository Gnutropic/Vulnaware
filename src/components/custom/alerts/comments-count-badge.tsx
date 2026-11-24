// @polsia:user-owned — Compact "N comments" badge rendered on /alerts rows
// when `GET /api/alerts` has stamped a `commentCount > 0` on this row. Server
// Component — no client state, no effects, no event handlers. The badge IS
// the link (no separate "view" button) via the Badge primitive's `asChild`
// Slot, pattern-matched to both `TrendingBadge` and `Button asChild` on the
// same primitive API.
//
// Tooltip: a static `title=` attribute explaining what a click will reveal
// — the operator pulls up the per-alert thread where the assignee-only
// composer lives. Mirrors the Trending badge's `title=` precedent so the
// row stack stays visually consistent; a Tooltip primitive would add
// another layer for one short affordance string.
//
// When `count <= 0` the component returns `null` — callers can safely
// render it unconditionally, but the row renderers still gate on `> 0`
// for parity with `TrendingBadge`.

import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { buildAlertDetailHref } from '@/lib/business/alerts-navigation';

export interface CommentsCountBadgeProps {
  count: number;
  alertId: string;
  detailQueryString?: string;
}

export function CommentsCountBadge({
  count,
  alertId,
  detailQueryString = '',
}: CommentsCountBadgeProps) {
  if (count <= 0) return null;
  const href = buildAlertDetailHref(alertId, detailQueryString);
  const tooltip = `${count} ${count === 1 ? 'comment' : 'comments'} — open the thread`;
  const label = `${count} ${count === 1 ? 'comment' : 'comments'}`;

  return (
    <Badge asChild variant="outline" className="font-mono text-caption" title={tooltip}>
      <Link href={href}>
        <MessageSquare aria-hidden="true" className="mr-1 inline size-3 align-[-0.18em]" />
        {label}
      </Link>
    </Badge>
  );
}
