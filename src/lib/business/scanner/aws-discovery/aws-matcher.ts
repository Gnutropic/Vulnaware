// @polsia:user-owned — Maps AWS-discovered assets to vuln findings. Sibling of
// src/lib/business/scanner/matcher.ts (which handles host:port assets). Same
// shape: a hardcoded seed table of (resourceType, predicate) → CVE, plus
// pure-function output that the orchestrator persists.
//
// We never import @/lib/db here — output is plain TS objects the orchestrator
// writes via prisma.create.

import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface AwsMatcherInput {
  accountId: string;
}

export interface AwsMatcherHit {
  resourceArn: string;
  cveId: string;
  severity: string | null;
  matchReason: string;
  // Provenance flag — 'synthesized' for these AWS-SEED entries (the AWS-*
  // ids are not real CVE entries, but they describe a real posture). The
  // orchestrator stamps `cveSource: 'synthesized'` on the resulting row.
  // 'shape' is reserved for matchResource() hits routed here to keep the
  // orchestrator stamping code uniform across providers.
  source: 'synthesized' | 'shape';
}

/**
 * Seed table. (resourceType, predicate) → list of CVEs. Loosely mirrors the
 * banner-driven seed in matcher.ts but keyed on AWS resource shape + tags +
 * exposure so a public EC2 instance, a public S3 bucket, or a non-compliant
 * IAM posture each produce a deterministic finding.
 */
interface AwsSeedEntry {
  resourceType: string;
  predicate: (a: AwsAssetDraft) => boolean;
  cveId: string;
  severity: string;
  matchReason: string;
}

const AWS_SEED: readonly AwsSeedEntry[] = [
  {
    resourceType: 's3:bucket',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'AWS-S3-PUBLIC-001',
    severity: 'Critical',
    matchReason:
      'AWS S3 bucket has a public-access policy without a complete PublicAccessBlock. Anonymous read / list is possible.',
  },
  {
    resourceType: 'ec2:instance',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'AWS-EC2-EXPOSED-001',
    severity: 'High',
    matchReason:
      'EC2 instance has a public IP. Recommend bring the workload behind an ALB + WAF or move to private subnets.',
  },
  {
    resourceType: 'config:compliance',
    predicate: (a) => a.publicExposure === 'public',
    cveId: 'AWS-CONFIG-NONCOMPLIANT-001',
    severity: 'High',
    matchReason:
      'AWS Config reports non-compliant managed rules. Review the rule list and remediation guidance.',
  },
  {
    resourceType: 'iam:account',
    predicate: (a) => {
      const hint = a.serviceHint ?? '';
      const m = /accessKeysPerUser=(\d+)/u.exec(hint);
      return m ? Number.parseInt(m[1] ?? '0', 10) > 0 : false;
    },
    cveId: 'AWS-IAM-LEGACY-KEY-001',
    severity: 'Medium',
    matchReason:
      'IAM account permits long-lived access keys. Use IAM roles + temporary credentials where possible; rotate existing keys.',
  },
];

export function matchAwsAssets(
  input: AwsMatcherInput,
  assets: readonly AwsAssetDraft[],
): AwsMatcherHit[] {
  const hits: AwsMatcherHit[] = [];
  for (const asset of assets) {
    for (const entry of AWS_SEED) {
      if (entry.resourceType !== asset.resourceType) continue;
      if (!entry.predicate(asset)) continue;
      const reason = `${entry.matchReason} [account=${input.accountId}]`;
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
