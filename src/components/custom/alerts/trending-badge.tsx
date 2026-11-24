// @polsia:user-owned — Compact "Trending" badge rendered on /alerts rows
// whose CVE id is in the workspace's latest
// VulnerabilityTrend.acceleratingIncreases list. Server Component — no
// client state, no effects, no event handlers. The badge IS the link
// (no separate "view" button) via the Badge primitive's `asChild` Slot,
// pattern-matched to `<Button asChild>` on the same primitive API.
//
// Tooltip: a static `title=` attribute that explains the underlying
// signal in one short line. We follow the existing Snooze badge's
// `title=` precedent on /alerts so parity with the chip stack stays
// low-cost — a Tooltip primitive would add another layer for one
// string of affordance text. The tooltip points operators to the
// per-CVE detail page where the workspace-wide velocity and per-CVE
// (recent, prior) counts render.

import { TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';

export interface TrendingBadgeProps {
  cveId: string;
}

export function TrendingBadge({ cveId }: TrendingBadgeProps) {
  // Encode safely so a CVE id with a slash or other reserved char
  // doesn't break the Link href.
  const href = `/alerts/trend/${encodeURIComponent(cveId)}`;
  const tooltip = 'Trending — this CVE is accelerating in your workspace right now';

  return (
    <Badge asChild variant="secondary" className="font-mono text-caption" title={tooltip}>
      <Link href={href}>
        <TrendingUp aria-hidden="true" className="mr-1 inline size-3 align-[-0.18em]" />
        Trending
      </Link>
    </Badge>
  );
}
