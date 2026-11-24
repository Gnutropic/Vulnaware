// @polsia:user-owned — AWS Config aggregator. Reads managed-rule compliance
// across regions the connection exposes. Aggregates the per-rule compliance
// state into a config:compliance asset the matcher can consult (e.g. ALL
// rules NON_COMPLIANT with the 'iam-root-access-key' rule = critical).

import 'server-only';
import {
  type ConfigServiceClient,
  DescribeConfigRulesCommand,
  GetComplianceDetailsByConfigRuleCommand,
} from '@aws-sdk/client-config-service';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface ConfigRulesParams {
  client: ConfigServiceClient;
  region: string;
  accountId: string;
}

interface ConfigRuleSummary {
  ConfigRuleName?: string;
  ConfigRuleArn?: string;
}

interface ComplianceDetail {
  ComplianceType?: string;
  ConfigRuleName?: string;
}

export async function enumerateConfigRules(params: ConfigRulesParams): Promise<AwsAssetDraft[]> {
  // DescribeConfigRules is per-region; the orchestrator fans out.
  const described = await params.client.send(new DescribeConfigRulesCommand({}));
  const rules = (described.ConfigRules ?? []) as ConfigRuleSummary[];
  if (rules.length === 0) return [];

  const complianceByRule = new Map<string, 'COMPLIANT' | 'NON_COMPLIANT' | 'NOT_APPLICABLE'>();
  for (const r of rules) {
    if (!r.ConfigRuleName) continue;
    try {
      const details = await params.client.send(
        new GetComplianceDetailsByConfigRuleCommand({
          ConfigRuleName: r.ConfigRuleName,
          Limit: 50,
        }),
        // Per-rule AWS Config charges apply — keep page size bounded.
      );
      const types = (details.EvaluationResults ?? []).map((d) => {
        const e = d as ComplianceDetail;
        return e.ComplianceType ?? 'NOT_APPLICABLE';
      });
      // If ANY resource is NON_COMPLIANT the rule is non-compliant overall.
      const nonOk = types.includes('NON_COMPLIANT');
      const compliant =
        types.length > 0 &&
        types.every((t) => t === 'COMPLIANT' || t === 'NOT_APPLICABLE') &&
        !nonOk;
      complianceByRule.set(
        r.ConfigRuleName,
        nonOk ? 'NON_COMPLIANT' : compliant ? 'COMPLIANT' : 'NOT_APPLICABLE',
      );
    } catch {
      complianceByRule.set(r.ConfigRuleName, 'NOT_APPLICABLE');
    }
  }

  const nonCompliantRules = Array.from(complianceByRule.entries())
    .filter(([, v]) => v === 'NON_COMPLIANT')
    .map(([k]) => k);

  return [
    {
      accountId: params.accountId,
      region: params.region,
      resourceType: 'config:compliance',
      // Synthetic ARN since compliance isn't a single AWS resource — encode
      // the per-region snapshot so the matcher can reason about it.
      resourceArn: `arn:aws:config:${params.region}:${params.accountId}:config-rule/compliance-summary`,
      resourceId: 'compliance-summary',
      publicExposure: nonCompliantRules.length > 0 ? 'public' : 'private',
      serviceHint: nonCompliantRules.slice(0, 5).join(',') || 'all_compliant',
    },
  ];
}
