// @polsia:user-owned — High-risk assets tile for the post-login
// /dashboard. Reads the active workspace's scored assets through the existing
// scoped `/api/assets` route and links each host to its detail page.

'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { DashboardCard } from '@/components/custom/dashboard/dashboard-card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { HIGH_RISK_PRIORITY_SCORE } from '@/lib/business/scanner/prioritize';
import {
  AssetList,
  type AssetList as AssetListType,
  type AssetRollupRow,
} from '@/lib/contracts/assets';

const ACTIVE_WORKSPACE_CHANGED_EVENT = 'active-workspace-changed';

const SKELETON_ROW_KEYS = [
  'top-assets-skel-0',
  'top-assets-skel-1',
  'top-assets-skel-2',
  'top-assets-skel-3',
  'top-assets-skel-4',
];

export function DashboardTopAssets(): ReactNode {
  const [data, setData] = useState<AssetListType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const loadAssets = () => {
      const currentRequestId = ++requestId;
      setLoading(true);
      setError(null);

      apiFetch(`/api/assets?sort=riskScore&minRiskScore=${HIGH_RISK_PRIORITY_SCORE}&pageSize=5`, {
        schema: AssetList,
      })
        .then((assets) => {
          if (!active || currentRequestId !== requestId) return;
          setData(assets);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!active || currentRequestId !== requestId) return;
          const message = err instanceof Error ? err.message : 'Unknown error';
          setError(message);
          setLoading(false);
        });
    };

    loadAssets();
    window.addEventListener(ACTIVE_WORKSPACE_CHANGED_EVENT, loadAssets);

    return () => {
      active = false;
      window.removeEventListener(ACTIVE_WORKSPACE_CHANGED_EVENT, loadAssets);
    };
  }, []);

  return (
    <section
      className="grid gap-3"
      data-testid="dashboard-top-assets"
      aria-label="High-risk assets"
    >
      <DashboardCard
        title="High-risk assets"
        description={`Assets with priority scores of ${HIGH_RISK_PRIORITY_SCORE} or higher.`}
      >
        {loading ? (
          <div className="mt-3 grid gap-2" aria-hidden="true">
            {SKELETON_ROW_KEYS.map((rowKey) => (
              <Skeleton key={rowKey} className="h-5 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="mt-3 flex h-24 items-center justify-center text-caption text-muted-foreground">
            —
          </div>
        ) : data === null ? (
          <div className="mt-3 flex h-24 items-center justify-center text-caption text-muted-foreground">
            —
          </div>
        ) : data.total === 0 ? (
          <p className="mt-3 text-caption text-muted-foreground">
            No high-risk assets in the active workspace yet.
          </p>
        ) : (
          <>
            <p className="mt-3 text-caption text-muted-foreground">
              {data.total.toLocaleString()} high-risk {data.total === 1 ? 'asset' : 'assets'}
              {' · '}showing the top five
            </p>
            <ul className="mt-3 grid gap-2">
              {data.items.map((item) => (
                <TopAssetRow key={item.name} item={item} />
              ))}
            </ul>
          </>
        )}
      </DashboardCard>
      {error ? (
        <p
          role="alert"
          className="max-w-prose text-caption text-muted-foreground"
          data-testid="dashboard-top-assets-error"
        >
          Couldn’t load highest-risk assets. Other dashboard tiles are unaffected.
        </p>
      ) : null}
    </section>
  );
}

function TopAssetRow({ item }: { item: AssetRollupRow }): ReactNode {
  const href = `/assets/${encodeURIComponent(item.name)}`;
  const score = item.riskScore === null ? '—' : `${item.riskScore.toFixed(2)} /10`;

  return (
    <li>
      <Link
        href={href}
        aria-label={`View asset ${item.name}, risk score ${score}`}
        data-testid={`dashboard-top-assets-row-${item.name}`}
        className="flex items-center justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-brand-500/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        <span className="truncate font-mono text-caption text-foreground">{item.name}</span>
        <Badge variant="outline" className="shrink-0 font-mono text-caption tabular-nums">
          Risk {score}
        </Badge>
      </Link>
    </li>
  );
}
