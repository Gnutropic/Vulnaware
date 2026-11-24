// @polsia:user-owned — AWS data-tier enumeration for the discovery fanout.
// Covers RDS instances + Aurora clusters via @aws-sdk/client-rds AND DynamoDB
// tables via @aws-sdk/client-dynamodb. Pure output — no @/lib/db imports so
// the orchestrator can write the drafts via prisma.createMany and feed the
// rows into matchAwsAssets + matchResource independently.
//
// Banner-driven host:port probing is intentionally out of scope here: that
// lives in matcher.ts and run-scan.ts. This file is shape-only — public/
// private/unknown posture + a serviceHint that's descriptive enough for the
// matcher seeds to fire on (e.g. 'engine=postgres&public=true').

import 'server-only';
import { type DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DescribeDBInstancesCommand, type RDSClient } from '@aws-sdk/client-rds';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface RdsEnumerateParams {
  /** Pre-built RDS client from the orchestrator's per-region loop. */
  client: RDSClient;
  region: string;
  accountId: string;
}

export interface DynamodbEnumerateParams {
  /** Pre-built DynamoDB client from the orchestrator's per-region loop. */
  client: DynamoDBClient;
  region: string;
  accountId: string;
}

/**
 * Lists RDS DB instances (incl. Aurora cluster members) in a single region.
 * Each instance becomes a single AwsAssetDraft with resourceType 'aws:rds:db'.
 * Public exposure comes from the SDK's `PubliclyAccessible` flag — a TRUE
 * value with no SG firewall in front is the public-RDS finding the matcher
 * flags. Aurora cluster members retain their DB-cluster identifier so the
 * matcher can dedupe by cluster if needed (the AWS_SEED entries don't
 * currently do this — but the data is here for future seed work).
 */
export async function enumerateRds(params: RdsEnumerateParams): Promise<AwsAssetDraft[]> {
  const out: AwsAssetDraft[] = [];
  let marker: string | undefined;
  do {
    const res = await params.client.send(
      new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }),
    );
    for (const inst of res.DBInstances ?? []) {
      const id = inst.DBInstanceIdentifier;
      const arn = inst.DBInstanceArn;
      if (!id || !arn) continue;
      const publicAccess = inst.PubliclyAccessible === true ? 'public' : 'private';
      out.push({
        accountId: params.accountId,
        region: params.region,
        resourceType: 'aws:rds:db',
        resourceArn: arn,
        resourceId: id,
        publicExposure: publicAccess,
        serviceHint: rdsHint(inst),
      });
    }
    marker = res.Marker;
  } while (marker);
  return out;
}

/**
 * Lists DynamoDB tables across a single region. We avoid the per-table
 * DescribeTable round-trip and synthesize the table ARN from the standard
 * AWS pattern `arn:aws:dynamodb:<region>:<account>:table/<name>` — the
 * unique identifier that AwsAsset.resourceArn needs. Public-ness for
 * DynamoDB tables comes from a resource policy `Principal: "*"` grant, but
 * checking that needs an extra call we want to skip — we tag `unknown` so
 * the matcher doesn't fire on `public`, only on shape-driven seed matches
 * that don't depend on exposure.
 */
export async function enumerateDynamoDbTables(
  params: DynamodbEnumerateParams,
): Promise<AwsAssetDraft[]> {
  const out: AwsAssetDraft[] = [];
  let lastName: string | undefined;
  do {
    const list = await params.client.send(
      new ListTablesCommand({ ExclusiveStartTableName: lastName, Limit: 100 }),
    );
    for (const name of list.TableNames ?? []) {
      if (!name) continue;
      out.push({
        accountId: params.accountId,
        region: params.region,
        resourceType: 'aws:dynamodb:table',
        resourceArn: dynamodbTableArn(params.region, params.accountId, name),
        resourceId: name,
        publicExposure: 'unknown',
        serviceHint: null,
      });
    }
    lastName = list.LastEvaluatedTableName;
  } while (lastName);
  return out;
}

function dynamodbTableArn(region: string, accountId: string, name: string): string {
  return `arn:aws:dynamodb:${region}:${accountId}:table/${name}`;
}

interface RdsInstanceView {
  Engine?: string | null;
  EngineVersion?: string | null;
  DBInstanceClass?: string | null;
  MultiAZ?: boolean | null;
  StorageEncrypted?: boolean | null;
  PubliclyAccessible?: boolean | null;
  DBClusterIdentifier?: string | null;
}

function rdsHint(inst: RdsInstanceView): string | null {
  const parts: string[] = [];
  if (inst.Engine) parts.push(`engine=${inst.Engine}`);
  if (inst.EngineVersion) parts.push(`version=${inst.EngineVersion}`);
  if (inst.DBInstanceClass) parts.push(`class=${inst.DBInstanceClass}`);
  if (inst.MultiAZ) parts.push('multi-az');
  if (inst.StorageEncrypted) parts.push('encrypted');
  if (inst.PubliclyAccessible) parts.push('public=true');
  if (inst.DBClusterIdentifier) parts.push(`cluster=${inst.DBClusterIdentifier}`);
  return parts.length > 0 ? parts.join(';') : null;
}
