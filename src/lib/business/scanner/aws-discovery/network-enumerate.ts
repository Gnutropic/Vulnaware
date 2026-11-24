// @polsia:user-owned — AWS network-tier enumeration for the discovery fanout.
// Lists VPCs, subnets, and security groups in a single region via
// @aws-sdk/client-ec2 (already installed). Pure output — no @/lib/db.
//
// Public exposure is derived from SG ingress rules: any rule with a
// `CidrIp` of `0.0.0.0/0` (IPv4) or `CidrIpv6` of `::/0` (IPv6) on a
// recognized port universe (we don't restrict port here — public means
// any inbound from the whole internet) flips the resource to 'public'.

import 'server-only';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface NetworkEnumerateParams {
  /** Pre-built EC2 client from the orchestrator's per-region loop. */
  client: EC2Client;
  region: string;
  accountId: string;
}

interface IpPermission {
  IpProtocol?: string | null;
  FromPort?: number | null;
  ToPort?: number | null;
  IpRanges?: Array<{ CidrIp?: string | null }> | null;
  Ipv6Ranges?: Array<{ CidrIpv6?: string | null }> | null;
}

interface SecurityGroupView {
  GroupId?: string | null;
  GroupName?: string | null;
  VpcId?: string | null;
  Description?: string | null;
  IpPermissions?: IpPermission[] | null;
  IpPermissionsEgress?: IpPermission[] | null;
  OwnerId?: string | null;
}

/**
 * VPC, subnet, and security-group enumeration. Both subnets and SGs are
 * 'public' when an inbound SG rule opens 0.0.0.0/0 (or ::/0); subnets are
 * tagged 'private' when we can't infer an SG link, else we tag the SG and
 * leave subnet deduced from VPC membership.
 */
export async function enumerateNetwork(params: NetworkEnumerateParams): Promise<AwsAssetDraft[]> {
  const out: AwsAssetDraft[] = [];

  // 1. VPCs.
  try {
    const vpcs = await params.client.send(new DescribeVpcsCommand({}));
    for (const vpc of vpcs.Vpcs ?? []) {
      const vpcId = vpc.VpcId;
      if (!vpcId) continue;
      const arn = vpcArn(params.region, params.accountId, vpcId);
      out.push({
        accountId: params.accountId,
        region: params.region,
        resourceType: 'aws:ec2:vpc',
        resourceArn: arn,
        resourceId: vpcId,
        // VPCs themselves aren't endpoints — none of them are public in the
        // data-plane sense; the SG/subnet rules are.
        publicExposure: 'private',
        serviceHint: vpc.CidrBlock ? `cidr=${vpc.CidrBlock}` : null,
      });
    }
  } catch {
    // continue with the rest of the enumeration
  }

  // 2. Subnets.
  try {
    const subs = await params.client.send(new DescribeSubnetsCommand({}));
    for (const subnet of subs.Subnets ?? []) {
      const subnetId = subnet.SubnetId;
      if (!subnetId) continue;
      const arn = subnetArn(params.region, params.accountId, subnetId);
      const vpcId = subnet.VpcId ?? null;
      // Public subnets: explicitly MapPublicIpOnLaunch=true is a stronger
      // signal than SG exposure alone — we tag those 'public' AND fall back
      // to 'private' otherwise. The matcher's seed entries don't yet depend
      // on this exposure flag (the AWS-EC2-EXPOSED-001 entry fires on EC2
      // instances, not subnets), so this is informational for now.
      const exposure =
        subnet.MapPublicIpOnLaunch === true
          ? 'public'
          : subnet.MapPublicIpOnLaunch === false
            ? 'private'
            : 'unknown';
      out.push({
        accountId: params.accountId,
        region: params.region,
        resourceType: 'aws:ec2:subnet',
        resourceArn: arn,
        resourceId: subnetId,
        publicExposure: exposure,
        serviceHint: vpcId ? `vpc=${vpcId}` : null,
      });
    }
  } catch {
    // continue
  }

  // 3. Security Groups.
  try {
    const sgs = await params.client.send(new DescribeSecurityGroupsCommand({}));
    for (const sg of sgs.SecurityGroups ?? []) {
      const groupId = sg.GroupId;
      if (!groupId) continue;
      const arn = securityGroupArn(params.region, params.accountId, groupId);
      const exposure = sgOpensToInternet(sg) ? 'public' : 'private';
      out.push({
        accountId: params.accountId,
        region: params.region,
        resourceType: 'aws:ec2:securitygroup',
        resourceArn: arn,
        resourceId: groupId,
        publicExposure: exposure,
        serviceHint: sg.GroupName ? `name=${sg.GroupName};vpc=${sg.VpcId ?? 'classic'}` : null,
      });
    }
  } catch {
    // continue
  }

  return out;
}

function vpcArn(region: string, account: string, vpcId: string): string {
  return `arn:aws:ec2:${region}:${account}:vpc/${vpcId}`;
}

function subnetArn(region: string, account: string, subnetId: string): string {
  return `arn:aws:ec2:${region}:${account}:subnet/${subnetId}`;
}

function securityGroupArn(region: string, account: string, sgId: string): string {
  return `arn:aws:ec2:${region}:${account}:security-group/${sgId}`;
}

/** True iff any IpPermission opens inbound to either 0.0.0.0/0 or ::/0. */
function sgOpensToInternet(sg: SecurityGroupView): boolean {
  for (const rule of sg.IpPermissions ?? []) {
    if (rule.IpProtocol === '-1') {
      // All-traffic wildcard — every direction, every protocol, every port.
      if (ruleHasPublicCidr(rule)) return true;
    }
    for (const range of rule.IpRanges ?? []) {
      if (range.CidrIp === '0.0.0.0/0') return true;
    }
    for (const range of rule.Ipv6Ranges ?? []) {
      if (range.CidrIpv6 === '::/0') return true;
    }
  }
  return false;
}

function ruleHasPublicCidr(rule: IpPermission): boolean {
  for (const range of rule.IpRanges ?? []) {
    if (range.CidrIp === '0.0.0.0/0') return true;
  }
  for (const range of rule.Ipv6Ranges ?? []) {
    if (range.CidrIpv6 === '::/0') return true;
  }
  return false;
}
