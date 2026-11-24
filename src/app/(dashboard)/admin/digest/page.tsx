// @polsia:user-owned — `/admin/digest` page. Server Component shell that
// exports metadata + applies the admin gate via `requireTeamRole('admin')`,
// then defers all data + button state to ONE client island:
//   <AdminDigestTrigger />, which:
//     - Fetches the 10 most-recent DigestLog rows for the caller's team
//       via `apiFetch('/api/admin/digest')`.
//     - POSTs to `apiFetch('/api/admin/digest/run')` on button submit.
//
// No `await prisma`, no DB imports here — every read/write goes through
// /api/admin/digest/** handlers. Server-side gate is admin-only so a
// non-admin caller sees a 403 with no content rendered.

import { Mail } from 'lucide-react';
import type { Metadata } from 'next';
import { AdminDigestTrigger } from '@/components/custom/dashboard/admin-digest-trigger';
import { brand } from '@/lib/brand';
import { requireTeamRole } from '@/lib/team-auth';

export const metadata: Metadata = {
  title: `Weekly digest — ${brand.name}`,
  description: `Trigger and review the Monday-morning AI-generated risk-trend digest for this ${brand.name} workspace.`,
};

export default async function AdminDigestPage() {
  // Server-side admin gate. Throws a 403 Response on non-admin callers
  // so the page body is never rendered to the wrong audience.
  await requireTeamRole('admin');

  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <p className="flex items-center gap-2 text-caption uppercase tracking-wide text-muted-foreground">
          <Mail aria-hidden className="size-4 text-brand-500" />
          Weekly digest
        </p>
        <h1 className="text-h2 text-foreground">Weekly AI risk-trend digest</h1>
        <p className="max-w-prose text-body text-muted-foreground">
          Every Monday morning at 08:00 UTC the cron pulls the latest CVE trend signal plus a
          snapshot of the past week&apos;s alerts, asks the platform Agent to write a short
          analyst-style summary, and emails the result to every active member of this workspace.
          Trigger an extra send anytime — the manual insert is recorded as a separate row in the log
          below.
        </p>
      </header>

      <AdminDigestTrigger />
    </div>
  );
}
