// @polsia:user-owned — /settings/integrations/notifications page. RSC shell
// that exports `metadata` for the page-level SEO and renders the
// <NotificationsPanel/> data island. The (dashboard)/settings/layout wraps
// the page in the dashboard shell, so this file stays purely structural.
//
// Data-plane rule: NO `await prisma`, NO `await fetch`, NO `@/lib/db`. Every
// datum on this page comes from the client island's apiFetch against
// /api/team/notifications. Even the saved URL, the deliveries count, and
// the test-result label are loaded by the island's GET.

import type { Metadata } from 'next';
import { NotificationsPanel } from '@/components/custom/notifications/panel';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Notifications — ${brand.name}`,
  description: `Fan ${brand.name} critical alerts out to a Slack-compatible webhook so your team catches them in the channel you already work in.`,
};

export default function NotificationsIntegrationsPage() {
  return <NotificationsPanel />;
}
