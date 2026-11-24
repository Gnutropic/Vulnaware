// @vitest-environment node — GCP matcher is pure TS; no DOM needed.
import { describe, expect, it } from 'vitest';
import { matchGcpAssets } from '@/lib/business/scanner/gcp-discovery/gcp-matcher';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

describe('matchGcpAssets — seed table', () => {
  it('flags a public GCE instance as High', () => {
    const assets: GcpAssetDraft[] = [
      {
        projectId: 'my-project',
        zone: 'us-central1-a',
        resourceType: 'compute.googleapis.com/Instance',
        resourceArn: 'projects/my-project/zones/us-central1-a/instances/vm1',
        resourceId: 'vm1',
        publicExposure: 'public',
        serviceHint: null,
      },
    ];
    const hits = matchGcpAssets({ projectId: 'my-project' }, assets);
    const found = hits.find((h) => h.cveId === 'GCP-VM-PUBLIC-001');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('High');
    expect(found?.matchReason).toContain('my-project');
  });

  it('flags a public Cloud Storage bucket as Critical', () => {
    const assets: GcpAssetDraft[] = [
      {
        projectId: 'my-project',
        zone: 'global',
        resourceType: 'storage.googleapis.com/Bucket',
        resourceArn: 'projects/my-project/buckets/leaky',
        resourceId: 'leaky',
        publicExposure: 'public',
        serviceHint: null,
      },
    ];
    const hits = matchGcpAssets({ projectId: 'my-project' }, assets);
    const found = hits.find((h) => h.cveId === 'GCP-BUCKET-PUBLIC-001');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('Critical');
  });

  it('does NOT flag a private GCE instance', () => {
    const assets: GcpAssetDraft[] = [
      {
        projectId: 'my-project',
        zone: 'us-central1-a',
        resourceType: 'compute.googleapis.com/Instance',
        resourceArn: 'projects/my-project/zones/us-central1-a/instances/vm-private',
        resourceId: 'vm-private',
        publicExposure: 'private',
        serviceHint: null,
      },
    ];
    const hits = matchGcpAssets({ projectId: 'my-project' }, assets);
    expect(hits).toEqual([]);
  });

  it('flags project IAM over-permission as High', () => {
    const assets: GcpAssetDraft[] = [
      {
        projectId: 'my-project',
        zone: 'global',
        resourceType: 'cloudresourcemanager.googleapis.com/Project',
        resourceArn: 'projects/my-project',
        resourceId: 'my-project',
        publicExposure: 'public',
        serviceHint: 'overPermissive=2;roles=roles/owner,roles/editor',
      },
    ];
    const hits = matchGcpAssets({ projectId: 'my-project' }, assets);
    const found = hits.find((h) => h.cveId === 'GCP-IAM-OVERPERM-001');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('High');
  });
});
