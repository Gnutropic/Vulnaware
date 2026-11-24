// @polsia:user-owned — Cloud run-detail page. Server component shell that
// exports per-page metadata and renders the client resolver island, which
// probes AWS/Azure/GCP discover endpoints to find the run.
// Gates anonymous visitors: redirect to /login?next=<this path>.

import { redirect } from 'next/navigation';
import { CloudRunResolver } from '@/components/custom/cloud-run-resolver';
import { brand } from '@/lib/brand';
import { getSessionUser } from '@/lib/require-auth';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  return {
    title: `Run ${id.slice(0, 12)} — ${brand.name}`,
    description: `${brand.name} cloud asset discovery run (AWS, Azure, or GCP).`,
  };
}

export default async function CloudRunPage({ params }: PageProps) {
  const { id } = await params;
  const session = await getSessionUser();
  if (!session) {
    redirect(`/login?next=/cloud/runs/${id}`);
  }
  return (
    <main className="container-page py-section">
      <div className="grid gap-8">
        <header className="grid gap-2">
          <h1 className="text-h2 text-foreground">Cloud discovery run</h1>
          <p className="text-caption text-muted-foreground">
            Watching a queued or in-flight run across AWS, Azure, or GCP. The page polls every 2
            seconds until the run reports a terminal status.
          </p>
        </header>
        <CloudRunResolver runId={id} />
      </div>
    </main>
  );
}
