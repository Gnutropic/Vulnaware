// @polsia:user-owned — Team Settings page. Server Component shell that
// exports metadata + applies the auth gate, then defers all data + UI state
// to four client islands. No `await prisma`, no DB imports here — every
// read/write goes through /api/team/memberships** handlers.

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AlertDigestToggle } from '@/components/custom/team/alert-digest-toggle';
import { TeamAssignForm } from '@/components/custom/team/assign-form';
import { DiscoverySchedulePanel } from '@/components/custom/team/discovery-schedule-panel';
import { TeamInviteForm } from '@/components/custom/team/invite-form';
import { TeamRosterTable } from '@/components/custom/team/roster-table';
import { brand } from '@/lib/brand';
import { getSessionUser } from '@/lib/require-auth';

export const metadata: Metadata = {
  title: `Team — ${brand.name}`,
  description: `Manage ${brand.name} team members and roles.`,
};

export default async function TeamSettingsPage() {
  // Redirect-only: never reach for prisma in a page. The roster table
  // resolves the actual team / membership rows through its apiFetch.
  const session = await getSessionUser();
  if (!session) {
    redirect('/login?next=/settings/team');
  }

  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <p className="text-caption uppercase tracking-wide text-muted-foreground">Settings</p>
        <h1 className="text-h2 text-foreground">Team</h1>
        <p className="max-w-prose text-body text-muted-foreground">
          Manage who can run scans and view results for this workspace. Owners, members, and viewers
          all live on the same team — their role controls what they can do.
        </p>
      </header>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Members</h2>
          <p className="text-caption text-muted-foreground">
            Active members and pending invitations appear here together.
          </p>
        </div>
        <TeamRosterTable />
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Invite by email</h2>
          <p className="text-caption text-muted-foreground">
            Sends a magic link; the recipient signs up if they don&rsquo;t have an account yet.
          </p>
        </div>
        <TeamInviteForm />
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Add an existing teammate</h2>
          <p className="text-caption text-muted-foreground">
            By existing email — they must already have an account.
          </p>
        </div>
        <TeamAssignForm />
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Scheduled cloud discovery runs</h2>
          <p className="text-caption text-muted-foreground">
            Periodic discovery against this team&rsquo;s cloud connections.
          </p>
        </div>
        <DiscoverySchedulePanel />
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Daily alert digest</h2>
          <p className="text-caption text-muted-foreground">
            Pause the workspace-wide 07:00 UTC digest without affecting per-alert dispatch.
          </p>
        </div>
        <AlertDigestToggle />
      </section>
    </div>
  );
}
