// @vitest-environment node — Azure compute enumerator fake-client test. No
// SDK imports — verifies the public-exposure classification from a fixture.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { enumerateVirtualMachines } from '@/lib/business/scanner/azure-discovery/compute-enumerate';

async function* asyncIterableFromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) yield item;
}

describe('enumerateVirtualMachines', () => {
  it('flags a VM with a public NIC IP as public', async () => {
    const client = {
      virtualMachines: {
        listAll: () =>
          asyncIterableFromArray([
            {
              id: '/subscriptions/x/virtualMachines/vm-public',
              name: 'vm-public',
              type: 'Microsoft.Compute/virtualMachines',
              location: 'eastus',
              networkProfile: {
                networkInterfaces: [
                  {
                    properties: {
                      publicIPAddress: { id: '/subscriptions/x/publicIPAddresses/p1' },
                    },
                  },
                ],
              },
            },
          ]),
      },
    };
    const drafts = await enumerateVirtualMachines({
      subscriptionId: '11111111-1111-1111-1111-111111111111',
      location: 'eastus',
      client: client as never,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.resourceType).toBe('microsoft.compute/virtualmachines');
    expect(drafts[0]?.publicExposure).toBe('public');
    expect(drafts[0]?.resourceArn).toBe('/subscriptions/x/virtualMachines/vm-public');
  });

  it('flags a VM with a private NIC as private', async () => {
    const client = {
      virtualMachines: {
        listAll: () =>
          asyncIterableFromArray([
            {
              id: '/subscriptions/x/virtualMachines/vm-private',
              name: 'vm-private',
              type: 'Microsoft.Compute/virtualMachines',
              location: 'eastus',
              networkProfile: {
                networkInterfaces: [{ properties: { publicIPAddress: null } }],
              },
            },
          ]),
      },
    };
    const drafts = await enumerateVirtualMachines({
      subscriptionId: '11111111-1111-1111-1111-111111111111',
      location: 'eastus',
      client: client as never,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.publicExposure).toBe('private');
  });

  it('skips VMs whose location does not match the requested one', async () => {
    const client = {
      virtualMachines: {
        listAll: () =>
          asyncIterableFromArray([
            {
              id: '/subscriptions/x/virtualMachines/vm-west',
              name: 'vm-west',
              type: 'x',
              location: 'westus',
              networkProfile: { networkInterfaces: [] },
            },
          ]),
      },
    };
    const drafts = await enumerateVirtualMachines({
      subscriptionId: '11111111-1111-1111-1111-111111111111',
      location: 'eastus',
      client: client as never,
    });
    expect(drafts).toEqual([]);
  });
});
