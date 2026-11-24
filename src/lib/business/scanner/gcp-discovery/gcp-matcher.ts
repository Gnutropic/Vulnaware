// @polsia:user-owned — Maps GCP-discovered assets to vuln findings. Mirrors
// `aws-matcher.ts`. Hardcoded seed table of (resourceType, predicate) →
// CVE. Emits 'GCP-*' synthesized cveIds — NEVER reuse AWS-* or AZ-*.

import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

export interface GcpMatcherInput {
  projectId: string;
}

export interface GcpMatcherHit {
  resourceArn: string;
  cveId: string;
  severity: string | null;
  matchReason: string;
  source: 'synthesized' | 'shape';
}

interface GcpSeedEntry {
  resourceType: string;
  predicate: (a: GcpAssetDraft) => boolean;
  cveId: string;
  severity: string;
  matchReason: string;
}

const GCP_SEED: readonly GcpSeedEntry[] = [
  {
    resourceType: 'compute.googleapis.com/Instance',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'GCP-VM-PUBLIC-001',
    severity: 'High',
    matchReason:
      'GCE instance has an external IP via accessConfigs (ONE_TO_ONE_NAT). Recommend Cloud NAT + private subnets.',
  },
  {
    resourceType: 'storage.googleapis.com/Bucket',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'GCP-BUCKET-PUBLIC-001',
    severity: 'Critical',
    matchReason:
      'Cloud Storage bucket grants access to allUsers or allAuthenticatedUsers. Recommend uniformBucketLevelAccess + publicAccessPrevention=enforced.',
  },
  {
    resourceType: 'cloudresourcemanager.googleapis.com/Project',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'GCP-IAM-OVERPERM-001',
    severity: 'High',
    matchReason:
      'Project IAM policy grants roles/owner or roles/editor to a wide principal set; review for least-privilege.',
  },
];

export function matchGcpAssets(
  input: GcpMatcherInput,
  assets: readonly GcpAssetDraft[],
): GcpMatcherHit[] {
  const hits: GcpMatcherHit[] = [];
  for (const asset of assets) {
    for (const entry of GCP_SEED) {
      if (entry.resourceType !== asset.resourceType) continue;
      if (!entry.predicate(asset)) continue;
      const reason = `${entry.matchReason} [project=${input.projectId}]`;
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
