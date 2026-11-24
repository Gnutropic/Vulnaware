// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.
//
// Pages in the (auth) route group render as Server Components so they
// can export per-page metadata. This page branches on the optional
// `tier` search param: when present (e.g. `/signup?tier=pro&trial=1`
// from a pricing CTA), it renders the tier-aware form island which
// provisions a workspace + Team + admin WorkspaceMember and signs the
// visitor in. Without the param, the original `<SignUpForm/>` is
// mounted so existing internal sign-ups (team invites, manual
// account creation) still work.
//
// The page itself performs NO DB reads, NO `fetch`, NO `next/headers`
// reads — only reads `searchParams` (Next 16 Promise) and narrows
// `tier` server-side via a zod enum safeParse. Unknown tier values
// fall back to the safe `starter` default before the form island
// renders.

import { SignUpForm } from '@/components/custom/sign-up-form';
import { SignupViewTracker } from '@/components/custom/trial/signup-view-tracker';
import { TierSignupForm } from '@/components/custom/trial/tier-signup-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';
import { TieredTrialSignupTier } from '@/lib/contracts/trial';

export const metadata = {
  title: `Create your ${brand.name} account`,
  description: `Sign up for a ${brand.name} trial workspace.`,
};

export default async function SignupPage({
  searchParams,
}: {
  // Next 16: `searchParams` is a Promise.
  searchParams: Promise<{ tier?: string; trial?: string }>;
}) {
  const params = await searchParams;

  // Narrow tier server-side. Anything outside the enum defaults to
  // 'starter' so an unknown value never reaches the orchestrator as
  // something it can't handle — the user can correct it from /pricing
  // if they want a different tier.
  const tierParse = params.tier ? TieredTrialSignupTier.safeParse(params.tier) : null;
  const trialTier = tierParse?.success ? tierParse.data : params.tier ? 'starter' : null;

  if (trialTier) {
    // Tier-aware branch — /pricing CTAs land here as
    // /signup?tier=pro&trial=1. The trial form posts to
    // /api/trial/tiered-signup which signs the visitor in and
    // redirects to /onboarding/welcome. The normalized tier is passed
    // down as a prop so the island renders the right tier badge.
    return (
      <main className="min-h-dvh flex items-center justify-center px-gutter py-section bg-[var(--background)]">
        <SignupViewTracker />

        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute top-[-30%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-[var(--brand-100)] opacity-40 blur-3xl" />
          <div className="absolute bottom-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--brand-200)] opacity-30 blur-3xl" />
        </div>

        <Card className="relative w-full max-w-xl shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-h4">Start your trial</CardTitle>
            <CardDescription>Stand up a {brand.name} workspace in under a minute.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <TierSignupForm tier={trialTier} />
            <p className="mt-4 text-center text-small text-muted-foreground">
              Already have an account?{' '}
              <a
                href="/login"
                className="text-brand-600 font-medium hover:text-brand-700 hover:underline underline-offset-2 transition-colors"
              >
                Sign in
              </a>
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-dvh flex items-center justify-center px-gutter py-section bg-[var(--background)]">
      <SignupViewTracker />

      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-30%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-[var(--brand-100)] opacity-40 blur-3xl" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--brand-200)] opacity-30 blur-3xl" />
      </div>

      <Card className="relative w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-h4">Create an account</CardTitle>
          <CardDescription>Get started — it&apos;s free</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <SignUpForm />
          <p className="mt-4 text-center text-small text-muted-foreground">
            Already have an account?{' '}
            <a
              href="/login"
              className="text-brand-600 font-medium hover:text-brand-700 hover:underline underline-offset-2 transition-colors"
            >
              Sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
