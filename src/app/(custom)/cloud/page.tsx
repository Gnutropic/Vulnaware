// @polsia:user-owned — Cloud home page = Cloud Environments view. Server
// component, exports per-page metadata; the data-bearing island lives in
// src/components/custom/cloud-environments-view.tsx. The connection CRUD
// moved to /cloud/connections per the brief — landing is now a thin
// summary that mirrors the brief's "provider badges + last-scan
// timestamps" wording.

import { CloudEnvironmentsView } from '@/components/custom/cloud-environments-view';
import { brand } from '@/lib/brand';

export const metadata = {
  title: `Cloud Environments — ${brand.name}`,
  description:
    'Inventory of your connected AWS, Azure, and GCP accounts. Each environment reports its most recent discovery scan + provider badge.',
};

export default function CloudPage() {
  return (
    <main className="container-page py-section">
      <div className="grid gap-6">
        <header className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-brand-50 p-6 shadow-md">
          <h1 className="text-h1 text-brand-900">Cloud environments</h1>
          <p className="text-body-lg text-brand-800">
            Connected AWS, Azure, and GCP accounts with the latest discovery scan for each. Use the{' '}
            <span className="font-medium">Connections</span> tab below to add a new account or audit
            the credential storage on existing ones.
          </p>
        </header>
        <CloudEnvironmentsView />
      </div>
    </main>
  );
}
