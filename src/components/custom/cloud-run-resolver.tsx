// @polsia:user-owned — Cloud run resolver. The runs/[id] page is shared
// across AWS, Azure, and GCP because the run id format is opaque to the
// user. Probe order: unified endpoint first (returns a `provider`
// discriminator so we skip the per-provider cascade), fall through to
// the three per-provider endpoints for backward-compat with pre-existing
// runs (none of the unified payload rows exists yet).

'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AwsRunStatus } from '@/components/custom/aws-run-status';
import { AzureRunStatus } from '@/components/custom/azure-run-status';
import { GcpRunStatus } from '@/components/custom/gcp-run-status';
import { CloudRunDetails } from '@/lib/contracts/cloud-discover';

type Provider = 'aws' | 'azure' | 'gcp';

async function probe(runId: string, provider: Provider): Promise<'found' | 'not-found' | 'error'> {
  try {
    const res = await fetch(`/api/${provider}/discover/${runId}`);
    if (res.status === 404) return 'not-found';
    if (!res.ok) return 'not-found';
    return 'found';
  } catch {
    return 'error';
  }
}

async function probeUnified(runId: string): Promise<Provider | null> {
  try {
    const res = await fetch(`/api/cloud/runs/${runId}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    // Validate via the shared zod contract — CloudRunDetails carries the
    // discriminator we route on.
    const body = (await res.json()) as unknown;
    const parsed = CloudRunDetails.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.provider;
  } catch {
    return null;
  }
}

export function CloudRunResolver({ runId }: { runId: string }) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      // 1. Try the unified endpoint first — it returns the provider
      // discriminator so we skip the per-provider cascade for any run
      // minted through /api/cloud/discover.
      const unified = await probeUnified(runId);
      if (unified) {
        if (!active) return;
        setProvider(unified);
        return;
      }

      // 2. Backward-compat: legacy runs minted through
      // /api/{aws,azure,gcp}/discover have no unified row; cascade
      // against the per-provider endpoints.
      for (const p of ['aws', 'azure', 'gcp'] as const) {
        const verdict = await probe(runId, p);
        if (verdict === 'found') {
          if (!active) return;
          setProvider(p);
          return;
        }
        if (verdict === 'error') {
          if (!active) return;
          setError('Failed to reach cloud discovery API.');
          return;
        }
      }
      if (!active) return;
      setError('Run not found in any cloud provider.');
    })();
    return () => {
      active = false;
    };
  }, [runId]);

  if (error) {
    return (
      <div
        className="rounded-[var(--radius)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-caption text-destructive"
        role="alert"
      >
        {error}
      </div>
    );
  }

  if (provider === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Locating run…
      </div>
    );
  }

  if (provider === 'aws') return <AwsRunStatus runId={runId} />;
  if (provider === 'azure') return <AzureRunStatus runId={runId} />;
  return <GcpRunStatus runId={runId} />;
}
