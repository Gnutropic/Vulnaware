// @polsia:user-owned — Per-host asset detail page. Server component
// that exports `generateMetadata` + the `?next=` round-trip redirect
// for anonymous visitors, then renders a single client island. NO
// await prisma / fetch / server-only import here — the data lives
// behind /api/assets/[host] and the island reads it via
// @/lib/api-client. Mirrors the posture of (dashboard)/alerts/[id]/
// page.tsx minus the helper-backed OG snapshot (this page does NOT
// surface host metadata to OG scrapers — see Risks in the brief).
//
// per-page `force-dynamic` so the redirect never lands on a cached
// shell before the auth lookup — required for `getSessionUser` to
// actually run on every visit.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AssetDetailClient } from '@/components/dashboard/asset-detail-client';
import { brand } from '@/lib/brand';
import { getSessionUser } from '@/lib/require-auth';

interface PageProps {
  params: Promise<{ host: string }>;
}

export const dynamic = 'force-dynamic';

function fallbackMetadata(host: string): Metadata {
  // Branded title + canonical + robots posture match the post-login
  // dashboard's authed pages — noindex so scrape bots can't leak
  // authenticated hostnames into search indexes; canonical so the
  // /assets/<host> URL is the unique target of any inbound link.
  const title = `Host: ${host} — ${brand.name}`;
  return {
    title: { default: title, template: `%s — ${brand.name}` },
    description: `Per-alert detail for the host ${host} in ${brand.name}: open count, severity breakdown, and triage list.`,
    robots: { index: false },
    alternates: { canonical: `/assets/${host}` },
    openGraph: {
      type: 'website',
      url: `/assets/${host}`,
      title,
      description: `Per-alert detail for the host ${host} in ${brand.name}.`,
      images: [{ url: '/opengraph-image' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: `Per-alert detail for the host ${host} in ${brand.name}.`,
      images: ['/opengraph-image'],
    },
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { host } = await params;
  // Decode so the title/canonical reflect the actual hostname, not the
  // route-segment encoded form. The route layer also decodes for the
  // Prisma where() — same encoding posture on both sides.
  let decoded = host;
  try {
    decoded = decodeURIComponent(host);
  } catch {
    /* leave raw `host` on the wire — generateMetadata must always
       return a valid object — and the route will still 400 on a
       malformed decoder input. */
  }
  return fallbackMetadata(decoded);
}

export default async function AssetDetailPage({ params }: PageProps) {
  const { host } = await params;

  // Per-page Server Component redirect (NOT a DashboardShell handoff).
  // The shell's client-side `router.replace('/login')` at
  // dashboard-shell.tsx:32-36 does NOT carry `?next=`, so the page
  // itself has to enforce the round-trip. Pattern mirrors
  // src/app/(auth)/account/digest/page.tsx:36-40.
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/assets/${encodeURIComponent(host)}`)}`);
  }

  // The Server Component hands the host to the client island; the
  // island fetches the envelope from /api/assets/<host> via apiFetch.
  // No prisma / fetch / await here — the d-plane rule is preserved by
  // construction.
  return <AssetDetailClient host={host} />;
}
