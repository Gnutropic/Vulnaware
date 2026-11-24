// @polsia:user-owned — public /billing/cancelled route. Server Component so it
// can export per-page metadata. Linked from /api/billing/team-subscribe's
// cancelUrl — Stripe redirects here when the buyer clicks "Back" on the hosted
// checkout. No charge has been made yet, so the message reassures them and
// routes back to pricing.

import { XCircle } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Checkout cancelled',
  description: `Your ${brand.name} Team checkout was cancelled. No charge was made.`,
  alternates: { canonical: '/billing/cancelled' },
  openGraph: {
    title: `Checkout cancelled · ${siteName}`,
    description: `Your ${brand.name} Team checkout was cancelled. No charge was made.`,
    url: '/billing/cancelled',
  },
  robots: { index: false, follow: false },
};

export default function BillingCancelledPage() {
  return (
    <main className="container-page section-lg">
      <Card className="border-border/80 bg-card shadow-md">
        <CardHeader className="gap-3">
          <Badge variant="outline" className="w-fit gap-1.5 font-normal text-muted-foreground">
            <XCircle className="size-3.5" aria-hidden />
            Checkout cancelled
          </Badge>
          <CardTitle className="font-display text-h2 tracking-tight text-foreground">
            No charge was made.
          </CardTitle>
          <CardDescription className="text-body-lg text-muted-foreground">
            {`You returned from Stripe without completing the Team subscription. Your card has not
            been charged — you can come back whenever you're ready.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/pricing">Back to pricing</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/contact">Talk to us</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
