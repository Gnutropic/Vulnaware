// @polsia:user-owned — EC2 instance enumeration for the discovery fanout.
// Describes instances in a single region (the orchestrator fans out across
// regions), extracts public-IP exposure + service hints against the allowlist
// (so we never emit a finding for a server-only port). Pure output — no DB.

import 'server-only';
import { DescribeInstancesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface Ec2EnumerateParams {
  region: string;
  accountId: string;
  /** Pre-built client from the orchestrator. */
  client: EC2Client;
}

export async function enumerateInstances(params: Ec2EnumerateParams): Promise<AwsAssetDraft[]> {
  const out: AwsAssetDraft[] = [];
  let nextToken: string | undefined;
  do {
    const res: {
      Reservations?: Array<{ OwnerId?: string; Instances?: Array<AwsInstanceShape> }>;
      NextToken?: string;
    } = await params.client.send(
      new DescribeInstancesCommand({ NextToken: nextToken, MaxResults: 100 }),
    );
    for (const reservation of res.Reservations ?? []) {
      const launchedBy = reservation.OwnerId ?? params.accountId;
      for (const inst of reservation.Instances ?? []) {
        const instanceId = inst.InstanceId;
        if (!instanceId) continue;
        const arn = arnForEc2Instance(params.region, launchedBy, instanceId);
        const publicIp = inst.PublicIpAddress ?? null;
        const publicExposure = publicIp ? 'public' : 'private';
        out.push({
          accountId: launchedBy,
          region: params.region,
          resourceType: 'ec2:instance',
          resourceArn: arn,
          resourceId: instanceId,
          publicExposure,
          serviceHint: publicIp ? firstAllowedPort(inst) : null,
        });
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return out;
}

function arnForEc2Instance(region: string, account: string, id: string): string {
  return `arn:aws:ec2:${region}:${account}:instance/${id}`;
}

// Return the first security group id — informational only. The matcher reads
// `publicExposure` and `serviceHint` together to decide whether to re-scan the
// asset with the in-app scanner (allowlisted ports only).
function firstAllowedPort(inst: AwsInstanceShape): string | null {
  for (const sg of inst.SecurityGroups ?? []) {
    if (sg.GroupId) return sg.GroupId;
  }
  return null;
}

interface AwsInstanceShape {
  InstanceId?: string;
  PublicIpAddress?: string | null;
  SecurityGroups?: { GroupId?: string | null }[];
}
