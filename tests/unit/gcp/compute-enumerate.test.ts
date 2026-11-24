// @vitest-environment node — GCP compute enumerator fake-client test.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { enumerateGceInstances } from '@/lib/business/scanner/gcp-discovery/compute-enumerate';

async function* asyncIterableFromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) yield item;
}

describe('enumerateGceInstances', () => {
  it('flags a GCE instance with external IP as public', async () => {
    const client = {
      aggregatedList: (_req: { project: string }) =>
        asyncIterableFromArray([
          [
            'zones/us-central1-a',
            {
              instances: {
                'projects/my-project/zones/us-central1-a/instances/vm-public': {
                  name: 'vm-public',
                  machineType: 'e2-medium',
                  networkInterfaces: [
                    {
                      accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'nat-1' }],
                    },
                  ],
                },
              },
            },
          ],
        ]),
    };
    const drafts = await enumerateGceInstances({
      projectId: 'my-project',
      zones: ['us-central1-a'],
      client: client as never,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.resourceType).toBe('compute.googleapis.com/Instance');
    expect(drafts[0]?.publicExposure).toBe('public');
    expect(drafts[0]?.zone).toBe('us-central1-a');
  });

  it('skips instances in zones not on the connection list', async () => {
    const client = {
      aggregatedList: (_req: { project: string }) =>
        asyncIterableFromArray([
          [
            'zones/europe-west1-b',
            {
              instances: {
                'projects/my-project/zones/europe-west1-b/instances/vm': {
                  name: 'vm',
                  networkInterfaces: [],
                },
              },
            },
          ],
        ]),
    };
    const drafts = await enumerateGceInstances({
      projectId: 'my-project',
      zones: ['us-central1-a'],
      client: client as never,
    });
    expect(drafts).toEqual([]);
  });

  it('skips region-scoped entries (only zones are GCE resources)', async () => {
    const client = {
      aggregatedList: (_req: { project: string }) =>
        asyncIterableFromArray([
          [
            'regions/us-central1',
            {
              instances: undefined,
            },
          ],
        ]),
    };
    const drafts = await enumerateGceInstances({
      projectId: 'my-project',
      zones: [],
      client: client as never,
    });
    expect(drafts).toEqual([]);
  });
});
