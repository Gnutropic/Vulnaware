// @polsia:user-owned — public /billing/success route. Server Component so
// it can export per-page metadata; per the data-plane rule this page does
// NOT call `verifyCheckoutSession` or `prisma` directly. The shipping
// Stripe Checkout substitutes `{CHECKOUT_SESSION_ID}` into the success URL,
// so by the time the page renders, the URL already carries `?session_id=`
// (and `?tier=` when the per-tier button deep-linked it).
//
// Server responsibilities on this turn:
//   1) Export per-page metadata (generic — tier-aware metadata requires
//      resolution of the verified payment, which would be a server-side
//      data read; the default metadata is fine).
//   2) Read `searchParams.session_id` and `searchParams.tier` — these are
//      presentation-time inputs, NOT data reads.
//   3) Mount <BillingSuccessIsland/> which performs the verify + write
//      through /api/billing/success-verify.
//   4) Render the "no checkout session" empty-state directly on the
//      server when `?session_id=` is absent — that's a static card, no
//      data is read.

import { CheckCircle2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BillingSuccessIsland } from '@/components/custom/billing/billing-success-island';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';
import { deriveTierSlugFromSearchParams } from '@/lib/business/pricing';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Subscription confirmed',
  description: `Your ${brand.name} subscription is being verified.`,
  alternates: { canonical: '/billing/success' },
  openGraph: {
    title: `Subscription confirmed · ${siteName}`,
    description: `Your ${brand.name} subscription is being verified.`,
    url: '/billing/success',
  },
  robots: { index: false, follow: false },
};

export default async function BillingSuccessPage({
  searchParams,
}: {
  // Next 16: `searchParams` is a Promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sessionIdRaw = params.session_id;
  const sessionId = Array.isArray(sessionIdRaw) ? (sessionIdRaw[0] ?? '') : (sessionIdRaw ?? '');
  const initialTier = deriveTierSlugFromSearchParams(params);

  if (!sessionId) {
    return (
      <main className="container-page section-lg">
        <Card className="border-border/80 bg-card shadow-sm">
          <CardHeader>
            <p className="text-eyebrow text-brand-500">No checkout session</p>
            <CardTitle className="font-display text-h2 tracking-tight">
              We could not find a checkout session.
            </CardTitle>
            <CardDescription>
              If you just completed a payment, head back to pricing and try again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/pricing">Return to pricing</Link>
            </Button>
          </CardContent>
        </Card>
        <p className="mt-6 text-caption text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-brand-500" aria-hidden /> Need help? Email{' '}
          <a href={`mailto:${brand.contactEmail}`} className="underline">
            {brand.contactEmail}
          </a>
          .
        </p>
      </main>
    );
  }

  return (
    <main className="container-page section-lg">
      <BillingSuccessIsland sessionId={sessionId} initialError={null} initialTier={initialTier} />
    </main>
  );
}
