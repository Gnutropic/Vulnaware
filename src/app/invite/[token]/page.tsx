// @polsia:user-owned — Public invite-accept landing page.
//
// /invite/[token]
// Server Component shell that exports metadata for OG/SEO. Every datum the
// page shows — the team name, the recipient email, the role, the validity
// state — is fetched by the client island from /api/invites/[token]; the
// page itself does NO DB reads, NO `fetch`, NO `next/headers` import, and
// NO `server-only` import. This keeps it compatible with the data-plane
// rule that pages never read or mutate app data directly.
//
// Invite tokens are sensitive — `robots: noindex, nofollow` so a leaked
// token doesn't get indexed by search engines.

import type { Metadata } from 'next';
import { InviteAcceptView } from '@/components/custom/invite/invite-accept-view';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Accept your invitation',
  description: `Confirm your invitation and join your ${brand.name} team workspace.`,
  robots: { index: false, follow: false },
};

export default async function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return (
    <main className="min-h-dvh flex items-center justify-center px-gutter py-section bg-[var(--background)]">
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-30%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-[var(--brand-100)] opacity-40 blur-3xl" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--brand-200)] opacity-30 blur-3xl" />
      </div>

      <InviteAcceptView token={token} />
    </main>
  );
}
