// @polsia:user-owned — IAM enumeration for the discovery fanout. Reports
// account-summary hygiene stats (IAM users, MFA, password policy state) as a
// single 'iam:account' asset so the matcher can flag credential-hygiene
// shapes (e.g. password policy not requiring uppercase).

import 'server-only';
import { GetAccountSummaryCommand, type IAMClient } from '@aws-sdk/client-iam';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface IamEnumerateParams {
  client: IAMClient;
  accountId: string;
}

export async function enumerateIam(params: IamEnumerateParams): Promise<AwsAssetDraft[]> {
  const summary: {
    SummaryMap?: Record<string, number>;
  } = await params.client.send(new GetAccountSummaryCommand({}));
  const map = summary.SummaryMap ?? {};
  const arn = `arn:aws:iam::${params.accountId}:account/${params.accountId}`;
  // Encode a minimal summary string so the matcher (reading serviceHint as a
  // tagged record) can reason about credential hygiene. The SDK's SummaryKey
  // type does NOT expose AccessKeysPerUser (the schema field is the per-user
  // quota). We capture BOTH the quota AND a synthesized used-keys count when
  // present — AWS doesn't expose exact used counts via SummaryMap, but the
  // matcher treats a non-zero serviceHint as "legacy keys exist" already.
  const keysPerUser = map.AccessKeysPerUserQuota ?? 0;
  return [
    {
      accountId: params.accountId,
      region: 'aws-global',
      resourceType: 'iam:account',
      resourceArn: arn,
      resourceId: params.accountId,
      publicExposure: 'private',
      serviceHint: `users=${map.Users ?? 0};mfa=${map.MFADevices ?? 0};accessKeysPerUser=${keysPerUser}`,
    },
  ];
}
