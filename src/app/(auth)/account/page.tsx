// @polsia:user-owned — authed /account route. Server Component so it can
// export per-page metadata. Per data-plane SKILL §"Two transports" the page
// does NOT call `getSessionUser()` for any data read — but keeps the
// structural auth gate (anonymous → /signup) because that's a routing
// decision, not a data read. The active-plan card is the only datum the
// page used to render and it now lives in /api/account/active-plan, so the
// entire content tree composes `use client` islands; the page is just the
// `metadata` export + auth gate + composition.
//
//   * <ActivePlanIsland userEmail={user.email ?? null} /> — reads
//     /api/account/active-plan on mount.
//   * <DailyDigestToggleSection /> and <AccountWebhookSection /> keep
//     their slot — they fetch their own /api routes from their own client
//     islands.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ActivePlanIsland } from '@/components/custom/account/active-plan-island';
import { DailyDigestToggleSection } from '@/components/custom/account/digest-section';
import { AccountWebhookSection } from '@/components/custom/account/webhook-section';
import { brand } from '@/lib/brand';
import { getSessionUser } from '@/lib/require-auth';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Your plan',
  description: `View your ${brand.name} subscription, manage billing, or upgrade to Team.`,
  alternates: { canonical: '/account' },
  openGraph: {
    title: `Your plan · ${siteName}`,
    description: `View your ${brand.name} subscription, manage billing, or upgrade to Team.`,
    url: '/account',
  },
  // Bots don't see authed pages (the server-side redirect strips them), so
  // noindex them explicitly — defensive against accidental /account hits
  // from a logged-in session that leaks via crawler share-links.
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  // Server-side gate: anonymous visitors are redirected to /signup (per
  // the brief). This is the ONLY server-side read — it's a routing
  // decision, not a datum (the resulting `user.email` is passed to the
  // island as a prop; the island itself fetches the plan slug).
  const user = await getSessionUser();
  if (!user) {
    redirect('/signup');
  }

  return (
    <main className="container-page section-lg">
      <ActivePlanIsland userEmail={user.email ?? null} />
      <section aria-labelledby="account-notifications-heading" className="mt-10 grid gap-6">
        <div className="grid gap-2">
          <p className="text-eyebrow text-brand-500">Notifications</p>
          <h2
            id="account-notifications-heading"
            className="font-display text-h2 tracking-tight text-foreground"
          >
            Notifications
          </h2>
          <p className="text-body text-muted-foreground">
            Outbound alerts and digests for your account. Changes save immediately.
          </p>
        </div>
        <div className="grid gap-6">
          <AccountWebhookSection />
          <DailyDigestToggleSection />
        </div>
      </section>
    </main>
  );
}
