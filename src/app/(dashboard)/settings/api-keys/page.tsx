// @polsia:user-owned — Manager page for API keys. Server Component; exports
// metadata for the page-level SEO. Renders the three client islands that
// actually do the work. NO `await prisma`, `@/lib/db`, or any data fetch in
// this file — every read goes through `apiFetch`.

import type { Metadata } from 'next';
import { ApiKeyCreateForm } from '@/components/custom/api-keys/create-form';
import { ApiKeyListView } from '@/components/custom/api-keys/list';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: `API keys — ${brand.name}`,
  description: `Issue and revoke scoped API tokens for the ${brand.name} enterprise REST surface.`,
};

export default function ApiKeysPage() {
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <p className="text-caption uppercase tracking-wide text-muted-foreground">Settings</p>
        <h1 className="text-h2 text-foreground">API keys</h1>
        <p className="max-w-prose text-body text-muted-foreground">
          Issue scoped tokens for the enterprise REST surface. Team-wide keys grant their
          team&apos;s admins the ability to list and read any scan owned by the team; single-scan
          keys are pinned to one scan id and can only trigger or read that scan. Copy the secret
          when it is shown — it cannot be retrieved later.
        </p>
      </header>

      <section className="grid gap-4">
        <h2 className="text-h3 text-foreground">Existing keys</h2>
        <ApiKeyListView />
      </section>

      <section className="grid gap-4">
        <h2 className="text-h3 text-foreground">Create a new key</h2>
        <ApiKeyCreateForm />
      </section>
    </div>
  );
}
