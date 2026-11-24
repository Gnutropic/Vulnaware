// @polsia:user-owned — Maps Azure-discovered assets to vuln findings. Mirrors
// `aws-matcher.ts` (same shape). Hardcoded seed table of (resourceType,
// predicate) → CVE. Emits 'AZ-*' synthesized cveIds — NEVER reuse AWS-* or
// GCP-*.

import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

export interface AzureMatcherInput {
  subscriptionId: string;
}

export interface AzureMatcherHit {
  resourceArn: string;
  cveId: string;
  severity: string | null;
  matchReason: string;
  source: 'synthesized' | 'shape';
}

interface AzureSeedEntry {
  resourceType: string;
  predicate: (a: AzureAssetDraft) => boolean;
  cveId: string;
  severity: string;
  matchReason: string;
}

export const AZURE_SEED: readonly AzureSeedEntry[] = [
  {
    resourceType: 'microsoft.compute/virtualmachines',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'AZ-VM-PUBLIC-001',
    severity: 'High',
    matchReason:
      'Azure VM has a public IP. Recommend moving the workload behind a Load Balancer + NSG or to a private subnet.',
  },
  {
    resourceType: 'microsoft.storage/storageaccounts',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'AZ-STG-PUBLIC-001',
    severity: 'Critical',
    matchReason:
      'Azure Storage account has allowBlobPublicAccess enabled and the network default allows traffic. Anonymous read / list is possible.',
  },
  {
    resourceType: 'microsoft.authorization/roleassignments',
    predicate: (a) => {
      const hint = a.serviceHint ?? '';
      if (!/^Owner\b/u.test(hint)) return false;
      return a.publicExposure === 'public';
    },
    cveId: 'AZ-IAM-OVERPERM-001',
    severity: 'High',
    matchReason:
      'Subscription-scope Owner role is assigned; review for least-privilege and prefer scoped custom roles.',
  },
];

export function matchAzureAssets(
  input: AzureMatcherInput,
  assets: readonly AzureAssetDraft[],
): AzureMatcherHit[] {
  const hits: AzureMatcherHit[] = [];
  for (const asset of assets) {
    for (const entry of AZURE_SEED) {
      if (entry.resourceType !== asset.resourceType) continue;
      if (!entry.predicate(asset)) continue;
      const reason = `${entry.matchReason} [subscription=${input.subscriptionId}]`;
      hits.push({
        resourceArn: asset.resourceArn,
        cveId: entry.cveId,
        severity: entry.severity,
        matchReason: reason,
        source: 'synthesized',
      });
    }
  }
  return hits;
}
