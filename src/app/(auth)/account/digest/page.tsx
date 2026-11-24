// @polsia:user-owned — authed /account/digest route. Server Component for
// `metadata` export + per-page `force-dynamic`. Mirrors the auth-gate
// posture of src/app/(auth)/account/page.tsx but lands on `/login?next=`
// (not `/signup`) so a return-from-sign-in round-trips the visitor back to
// this exact URL.
//
// Per data-plane SKILL §"Two transports" the page does NOT call
// `getSessionUser()` for any data read — only for the structural auth gate
// (anonymous → /login?next=/account/digest). Every datum the page renders
// (current toggle, badge, "last updated" stamp) is fetched on mount by
// the `<DailyDigestToggleSection/>` client island via `apiFetch` against
// /api/account/digest.

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DailyDigestToggleSection } from '@/components/custom/account/digest-section';
import { brand } from '@/lib/brand';
import { getSessionUser } from '@/lib/require-auth';
import { siteName } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Daily digest',
  description: `Choose whether ${brand.name} emails you a daily recap. Changes save immediately.`,
  alternates: { canonical: '/account/digest' },
  openGraph: {
    title: `Daily digest · ${siteName}`,
    description: `Choose whether ${brand.name} emails you a daily recap. Changes save immediately.`,
    url: '/account/digest',
  },
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function DigestSettingsPage() {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent('/account/digest')}`);
  }

  return (
    <main className="container-page section-lg">
      <Link href="/account" className="text-eyebrow text-brand-500 hover:underline">
        ← Back to account
      </Link>
      <section aria-labelledby="account-digest-heading" className="mt-4 grid gap-6">
        <div className="grid gap-2">
          <p className="text-eyebrow text-brand-500">Notifications</p>
          <h2
            id="account-digest-heading"
            className="font-display text-h2 tracking-tight text-foreground"
          >
            Daily digest
          </h2>
          <p className="text-body text-muted-foreground">
            Pick whether {brand.name} sends you a once-a-day email recap. The toggle saves
            immediately and can be flipped any time.
          </p>
        </div>
        <DailyDigestToggleSection />
      </section>
    </main>
  );
}
