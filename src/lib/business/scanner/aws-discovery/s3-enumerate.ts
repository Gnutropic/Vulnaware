// @polsia:user-owned — S3 enumeration for the discovery fanout. Lists buckets
// and per-bucket checks public-access posture. Logs a critical exposure when
// a bucket has `Principal: "*"` in its policy AND no PublicAccessBlock in
// place; otherwise records the bucket and its posture only.

import 'server-only';
import {
  GetBucketPolicyCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

export interface S3EnumerateParams {
  /** Pre-built, regional S3 client. */
  client: S3Client;
  /** Use us-east-1 explicitly for ListBuckets; the SDK defaults there for
   *  global operations, but we surface it. */
  ownerAccount: string;
}

interface PublicAccessBlockResponse {
  BlockPublicAcls?: boolean;
  IgnorePublicAcls?: boolean;
  BlockPublicPolicy?: boolean;
  RestrictPublicBuckets?: boolean;
}

export async function enumerateBuckets(params: S3EnumerateParams): Promise<AwsAssetDraft[]> {
  const out: AwsAssetDraft[] = [];
  const list = await params.client.send(new ListBucketsCommand({}));
  const buckets = list.Buckets ?? [];
  for (const b of buckets) {
    if (!b.Name) continue;
    const created = b.CreationDate;
    const arn = `arn:aws:s3:::${b.Name}`;
    const exposure = await readExposure(params.client, b.Name);
    out.push({
      accountId: params.ownerAccount,
      region: 'us-east-1', // bucket ARN has no region; we tag the home region
      resourceType: 's3:bucket',
      resourceArn: arn,
      resourceId: b.Name,
      publicExposure: exposure,
      serviceHint: created ? `created=${created.toISOString().slice(0, 10)}` : null,
    });
  }
  return out;
}

async function readExposure(
  client: S3Client,
  bucket: string,
): Promise<'public' | 'private' | 'unknown'> {
  let policyAllowsPublic = false;
  try {
    const policy = await client.send(
      new GetBucketPolicyCommand({ Bucket: bucket, ExpectedBucketOwner: undefined }),
    );
    if (typeof policy.Policy === 'string' && /"Principal"\s*:\s*"\*"/u.test(policy.Policy)) {
      policyAllowsPublic = true;
    }
  } catch {
    // NoSuchBucketPolicy OR AccessDenied — treat as not (known) public.
  }

  let pab: PublicAccessBlockResponse = {};
  try {
    const pabRes = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    pab = (pabRes.PublicAccessBlockConfiguration ?? {}) as PublicAccessBlockResponse;
  } catch {
    pab = {};
  }

  const pabFullyBlocks =
    pab.BlockPublicAcls === true &&
    pab.IgnorePublicAcls === true &&
    pab.BlockPublicPolicy === true &&
    pab.RestrictPublicBuckets === true;

  if (policyAllowsPublic && !pabFullyBlocks) return 'public';
  if (policyAllowsPublic && pabFullyBlocks) return 'private'; // belt + suspenders
  return 'private';
}
