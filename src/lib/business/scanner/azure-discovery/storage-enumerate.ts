// @polsia:user-owned — Azure Storage account enumeration. Lists storage accounts
// across the subscription (storage is global within a subscription — no
// per-location split). Classifies public exposure from the
// `allowBlobPublicAccess` property + the network defaultAction.

import 'server-only';
import type { StorageManagementClient } from '@azure/arm-storage';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

export interface AzureStorageParams {
  subscriptionId: string;
  client: StorageManagementClient;
}

interface StorageAccountView {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  location?: string | null;
  allowBlobPublicAccess?: boolean | null;
  networkRuleDefaultAction?: string | null;
  publicNetworkAccess?: string | null;
}

export async function enumerateStorageAccounts(
  params: AzureStorageParams,
): Promise<AzureAssetDraft[]> {
  const out: AzureAssetDraft[] = [];
  const iter = params.client.storageAccounts.list() as AsyncIterable<StorageAccountView>;
  for await (const acct of iter) {
    if (!acct.id || !acct.name) continue;
    const exposure = classifyExposure(acct);
    out.push({
      subscriptionId: params.subscriptionId,
      location: (acct.location ?? 'unknown').toLowerCase(),
      resourceType: 'microsoft.storage/storageaccounts',
      resourceArn: acct.id,
      resourceId: acct.name,
      publicExposure: exposure,
      serviceHint: acct.type ?? null,
    });
  }
  return out;
}

function classifyExposure(a: StorageAccountView): 'public' | 'private' | 'unknown' {
  const pna = a.publicNetworkAccess?.toLowerCase();
  if (pna === 'disabled') return 'private';
  if (a.allowBlobPublicAccess === true && a.networkRuleDefaultAction === 'Allow') return 'public';
  if (a.allowBlobPublicAccess === true) return 'public';
  if (a.allowBlobPublicAccess === false) return 'private';
  return 'unknown';
}
