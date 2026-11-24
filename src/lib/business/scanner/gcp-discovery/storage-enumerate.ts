// @polsia:user-owned — GCP Cloud Storage bucket enumeration. Uses the
// Storage SDK. We page through `getBuckets()` (returns bucket metadata
// directly so we don't need a per-bucket fetch), then read IAM configuration
// + ACLs to classify public exposure.

import 'server-only';
import type { Bucket, GetBucketsResponse, Storage } from '@google-cloud/storage';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

export interface GcpStorageParams {
  projectId: string;
  /**
   * The Storage SDK is heavy. Tests inject a stub with the same surface.
   * `getBuckets(options?)` returns either a single page or an auto-streamed
   * bucket array (`maxResults`/`pageSize` honored).
   */
  client: Pick<Storage, 'getBuckets'>;
}

export async function enumerateGcsBuckets(params: GcpStorageParams): Promise<GcpAssetDraft[]> {
  const out: GcpAssetDraft[] = [];
  const [buckets] = await params.client.getBuckets();
  for (const b of buckets) {
    const meta = b.metadata as BucketMetadataView;
    const exposure = classifyExposure(meta);
    out.push({
      projectId: params.projectId,
      zone: 'global',
      resourceType: 'storage.googleapis.com/Bucket',
      resourceArn: `projects/${params.projectId}/buckets/${b.name}`,
      resourceId: b.name,
      publicExposure: exposure,
      serviceHint: meta.iamConfiguration?.uniformBucketLevelAccess?.enabled
        ? 'uniform_access'
        : 'fine_grained',
    });
  }
  return out;
}

interface BucketMetadataView {
  name?: string;
  iamConfiguration?: {
    uniformBucketLevelAccess?: { enabled?: boolean } | null;
    publicAccessPrevention?: string | null;
  } | null;
  // Legacy fine-grained model.
  acl?: Array<{ entity?: string }> | null;
  defaultObjectAcl?: Array<{ entity?: string }> | null;
}

// Re-export a getBuckets response type for tests that need a stable signature.
export type { GetBucketsResponse, Bucket };

function classifyExposure(meta: BucketMetadataView): 'public' | 'private' | 'unknown' {
  const p = meta.iamConfiguration?.publicAccessPrevention;
  if (p === 'enforced') return 'private';
  for (const entry of meta.acl ?? []) {
    if (entry.entity === 'allUsers' || entry.entity === 'allAuthenticatedUsers') return 'public';
  }
  for (const entry of meta.defaultObjectAcl ?? []) {
    if (entry.entity === 'allUsers' || entry.entity === 'allAuthenticatedUsers') return 'public';
  }
  if (p === 'inherited' || p === 'unspecified') return 'unknown';
  return 'private';
}
