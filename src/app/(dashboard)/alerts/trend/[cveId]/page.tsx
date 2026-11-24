// @polsia:user-owned — Per-CVE trending detail page. Server Component
// that only exports metadata and renders the TrendDetailView client
// island. NO DB / fetch in this file — the data lives behind
// /api/alerts/trend/[cveId] and the island reads it via apiFetch.
// Mirrors the posture of /alerts/[id]/page.tsx (dashboard auth is
// enforced by the layout shell, not here).
//
// Metadata is built statically with the cveId interpolated from
// `params`; no DB-derived content. Robots: noindex — the row badge
// links straight to the per-CVE slice and operators expect the
// landing to live or 404 atomically.

import type { Metadata } from 'next';
import { TrendDetailView } from '@/components/custom/alerts/trend-detail-view';
import { brand } from '@/lib/brand';

interface PageProps {
  params: Promise<{ cveId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { cveId } = await params;
  return {
    title: {
      default: `Trending · ${cveId} — ${brand.name}`,
      template: `%s — ${brand.name}`,
    },
    description: `Per-CVE trending detail for ${cveId}: workspace velocity, recent-30d vs prior-30d alert counts, neighboring CVEs in the same accelerating set.`,
    robots: { index: false },
  };
}

export default async function TrendDetailPage({ params }: PageProps) {
  // Server Component — only reads `params` to pass the cveId forward
  // into the client island. No await prisma / fetch / server-only
  // import here, so the data-plane rule is preserved by construction.
  const { cveId } = await params;
  return <TrendDetailView cveId={cveId} />;
}
