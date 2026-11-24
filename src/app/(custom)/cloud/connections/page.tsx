// @polsia:user-owned — Connection-management sub-route. Server component,
// exports per-page metadata; the per-provider CRUD stays as three client
// islands to preserve the existing form + table composition.

import { AwsConnectionListView } from '@/components/custom/aws-conn-list';
import { AwsConnectionForm } from '@/components/custom/aws-connection-form';
import { AzureConnectionListView } from '@/components/custom/azure-conn-list';
import { AzureConnectionForm } from '@/components/custom/azure-connection-form';
import { GcpConnectionListView } from '@/components/custom/gcp-conn-list';
import { GcpConnectionForm } from '@/components/custom/gcp-connection-form';
import { brand } from '@/lib/brand';

export const metadata = {
  title: `Cloud connections — ${brand.name}`,
  description: `Add, audit, and remove AWS / Azure / GCP connections used by ${brand.name} for cloud asset discovery.`,
};

export default function CloudConnectionsPage() {
  return (
    <main className="container-page py-section">
      <div className="grid gap-10">
        <header className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-brand-50 p-6 shadow-md">
          <h1 className="text-h1 text-brand-900">Cloud connections</h1>
          <p className="text-body-lg text-brand-800">
            Connect a cross-account AWS role, an Azure service principal, or a GCP service account.
            {` ${brand.name} enumerates your cloud assets via the credential you provide and stores the
            credential per row so each run can mint a fresh token.`}
          </p>
          <p className="text-caption text-brand-800">
            Remove a connection to revoke access. AWS uses STS AssumeRole and never persists
            long-lived IAM user keys; Azure and GCP store the supplied secret verbatim per row —
            keep this in mind before deleting a connection from a shared account.
          </p>
        </header>

        <section className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-foreground">AWS</h2>
            <span className="text-caption text-muted-foreground">Cross-account IAM role</span>
          </div>
          <p className="text-body text-muted-foreground">
            Connections are owner-scoped. AWS uses sts:AssumeRole and never persists long- lived
            access keys.
          </p>
          <AwsConnectionForm />
          <AwsConnectionListView />
        </section>

        <section className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-foreground">Azure</h2>
            <span className="text-caption text-muted-foreground">Service principal auth</span>
          </div>
          <p className="text-body text-muted-foreground">
            Connections store a tenant id, client id, subscription id, and client secret per row.
            Use a credential with read-only access to the resources you want enumerated.
          </p>
          <AzureConnectionForm />
          <AzureConnectionListView />
        </section>

        <section className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-foreground">GCP</h2>
            <span className="text-caption text-muted-foreground">Service-account auth</span>
          </div>
          <p className="text-body text-muted-foreground">
            Connections store a project id and a full service-account JSON per row so each run can
            mint a fresh OAuth2 token. The <code>Viewer</code> role on the project is sufficient for
            read-only discovery.
          </p>
          <GcpConnectionForm />
          <GcpConnectionListView />
        </section>
      </div>
    </main>
  );
}
