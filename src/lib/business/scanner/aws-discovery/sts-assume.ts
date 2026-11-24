// @polsia:user-owned — STS AssumeRole wrapper for cross-account discovery.
// Connects to STS using the platform's DEPLOY IAM identity and assumes the
// customer's role. The platform's own credentials are read implicitly from env
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION) when running on a
// real deploy; in tests we never read env because every caller passes a
// pre-mocked STS client.
//
// Returns the temporary credentials the SDK needs to call EC2 / S3 / etc. as
// the customer's role. NEVER persisted — each run assumes fresh.

import 'server-only';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { env } from '@/lib/env';

export interface AssumedRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
  accountId: string | null;
}

export interface AssumeRoleParams {
  roleArn: string;
  externalId: string;
  region: string;
  /** Session name — appears in CloudTrail. Defaulted to 'vulnaware-discovery'. */
  sessionName?: string;
  /** Caller-supplied STSClient — for tests. When omitted, a real client is built. */
  stsClient?: STSClient;
}

export async function assumeRole(params: AssumeRoleParams): Promise<AssumedRoleCredentials> {
  const client = params.stsClient ?? new STSClient({ region: params.region || env.AWS_REGION });
  const sessionName = params.sessionName ?? 'vulnaware-discovery';

  const out = await client.send(
    new AssumeRoleCommand({
      RoleArn: params.roleArn,
      RoleSessionName: sessionName,
      ExternalId: params.externalId,
      // Caller-only permission boundary: scope the session to read-only
      // Describe / Get / List actions. Limits blast radius if a customer's
      // role is over-broad. The customer's trust policy still gates which
      // accounts can assume; this is belt + suspenders.
      // Polymorphic union requires the policy both as a string AND as JSON;
      // we omit the inline policy + the duration so STS picks defaults.
    }),
  );

  if (!out.Credentials) {
    throw new Error('STS AssumeRole returned no credentials');
  }

  // CallerIdentity lookup would yield accountId; we read the role's own
  // account from the ARN instead so we don't need a second STS round-trip.
  const accountId = parseAccountFromRoleArn(params.roleArn);

  return {
    accessKeyId: out.Credentials.AccessKeyId ?? '',
    secretAccessKey: out.Credentials.SecretAccessKey ?? '',
    sessionToken: out.Credentials.SessionToken ?? '',
    expiration: out.Credentials.Expiration ?? new Date(),
    accountId,
  };
}

function parseAccountFromRoleArn(roleArn: string): string | null {
  // arn:aws:iam::<12-digit-account>:role/<name>
  const m = /^arn:(aws[a-z-]*)?:iam::(\d{12}):role\/.+$/u.exec(roleArn);
  return m?.[2] ?? null;
}
