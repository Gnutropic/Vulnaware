// @polsia:user-owned — AWS Resource Explorer 2 aggregator. When the customer
// has Resource Explorer enabled in the account, we use it for a single
// account-wide search; otherwise we fall back to per-service enumeration in
// each module. The aggregator never BLOCKS — failure here is logged in the
// run's errorMessage and the orchestrator falls back to per-service scans.

import 'server-only';
import { type ResourceExplorer2Client, SearchCommand } from '@aws-sdk/client-resource-explorer-2';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface ResourceExplorerParams {
  /** Pre-built client. */
  client: ResourceExplorer2Client;
  /**
   * Query string. Defaults to "*" — every resource visible to the assumed
   * role. Tuned per run by settings; the orchestrator uses the default.
   */
  query?: string;
}

interface ResourceExplorerHit {
  Arn?: string | null;
  Service?: string | null;
  Region?: string | null;
  AccountId?: string | null;
  ResourceType?: string | null;
}

export async function enumerateViaResourceExplorer(
  params: ResourceExplorerParams,
): Promise<AwsAssetDraft[]> {
  const out: AwsAssetDraft[] = [];
  let next: string | undefined;
  do {
    const res: {
      Resources?: ResourceExplorerHit[];
      NextToken?: string;
    } = await params.client.send(
      new SearchCommand({
        QueryString: params.query ?? '*',
        MaxResults: 100,
        NextToken: next,
      }),
    );
    for (const hit of (res.Resources ?? []) as ResourceExplorerHit[]) {
      const arn = hit.Arn;
      if (!arn) continue;
      out.push({
        accountId: hit.AccountId ?? 'unknown',
        region: hit.Region ?? 'unknown',
        resourceType: hit.ResourceType ?? `aws:${hit.Service ?? 'unknown'}`,
        resourceArn: arn,
        resourceId: arn.split('/').pop() ?? arn.split(':').pop() ?? null,
        publicExposure: 'unknown',
        serviceHint: hit.Service ?? null,
      });
    }
    next = res?.NextToken ?? undefined;
  } while (next);

  return out;
}
