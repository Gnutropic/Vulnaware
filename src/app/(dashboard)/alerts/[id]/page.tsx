// @polsia:user-owned — Vulnerability detail page. Server component that
// exports generic, non-indexable metadata and renders the existing client
// island. Alert data is fetched by the island through the scoped API route.

import type { Metadata } from 'next';
import { AlertDetailClient } from '@/components/dashboard/alert-detail-client';
import { brand } from '@/lib/brand';
import { buildAlertReturnHref } from '@/lib/business/alerts-navigation';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: { absolute: `Alert details — ${brand.name}` },
  description: `Review vulnerability alert details in ${brand.name}.`,
  robots: { index: false, follow: false },
};

export default async function AlertDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, listSearchParams] = await Promise.all([params, searchParams]);
  return <AlertDetailClient id={id} returnHref={buildAlertReturnHref(listSearchParams)} />;
}
