// @polsia:user-owned — Settings/intel page. Server Component that
// exports metadata, applies the auth gate (anon → /login), and
// composes a single client island (`<IntelRunsList/>`) so the page
// itself owns NO data plane code. Every read goes through the
// `/api/intel/runs` route handler.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { IntelRunsList } from '@/components/custom/intel/runs-list';
import { brand } from '@/lib/brand';
import { getSessionUser } from '@/lib/require-auth';

export const metadata: Metadata = {
  title: `Intel — ${brand.name}`,
  description: `Daily competitive-intelligence audits for ${brand.name}, generated nightly and consumable from this page.`,
};

export default async function IntelSettingsPage() {
  // Redirect-only: the listing island pulls actual rows via apiFetch.
  const session = await getSessionUser();
  if (!session) {
    redirect('/login?next=/settings/intel');
  }

  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <p className="text-caption uppercase tracking-wide text-muted-foreground">Settings</p>
        <h1 className="text-h2 text-foreground">Intel</h1>
        <p className="max-w-prose text-body text-muted-foreground">
          Nightly competitive-intelligence audits for your workspace. Each row is a fresh read from
          the {brand.name} audit pipeline; click a card to expand the full body.
        </p>
      </header>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Audit reports</h2>
          <p className="text-caption text-muted-foreground">Newest first.</p>
        </div>
        <IntelRunsList />
      </section>
    </div>
  );
}
