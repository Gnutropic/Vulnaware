// @vitest-environment node — Azure matcher is pure TS; no DOM needed.
import { describe, expect, it } from 'vitest';
import { matchAzureAssets } from '@/lib/business/scanner/azure-discovery/azure-matcher';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

describe('matchAzureAssets — seed table', () => {
  it('flags a public Azure VM as High', () => {
    const assets: AzureAssetDraft[] = [
      {
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        location: 'eastus',
        resourceType: 'microsoft.compute/virtualmachines',
        resourceArn: '/subscriptions/x/virtualMachines/vm1',
        resourceId: 'vm1',
        publicExposure: 'public',
        serviceHint: null,
      },
    ];
    const hits = matchAzureAssets(
      { subscriptionId: '11111111-1111-1111-1111-111111111111' },
      assets,
    );
    const found = hits.find((h) => h.cveId === 'AZ-VM-PUBLIC-001');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('High');
    expect(found?.matchReason).toContain('11111111-1111-1111-1111-111111111111');
  });

  it('flags a public Azure Storage account as Critical', () => {
    const assets: AzureAssetDraft[] = [
      {
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        location: 'eastus',
        resourceType: 'microsoft.storage/storageaccounts',
        resourceArn: '/subscriptions/x/storageAccounts/leaky',
        resourceId: 'leaky',
        publicExposure: 'public',
        serviceHint: null,
      },
    ];
    const hits = matchAzureAssets(
      { subscriptionId: '11111111-1111-1111-1111-111111111111' },
      assets,
    );
    const found = hits.find((h) => h.cveId === 'AZ-STG-PUBLIC-001');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('Critical');
  });

  it('does NOT flag a private Azure Storage account', () => {
    const assets: AzureAssetDraft[] = [
      {
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        location: 'eastus',
        resourceType: 'microsoft.storage/storageaccounts',
        resourceArn: '/subscriptions/x/storageAccounts/private',
        resourceId: 'private',
        publicExposure: 'private',
        serviceHint: null,
      },
    ];
    const hits = matchAzureAssets(
      { subscriptionId: '11111111-1111-1111-1111-111111111111' },
      assets,
    );
    expect(hits).toEqual([]);
  });

  it('flags subscription-scope Owner role as High', () => {
    const assets: AzureAssetDraft[] = [
      {
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        location: 'subscription-scope',
        resourceType: 'microsoft.authorization/roleassignments',
        resourceArn: '/providers/Microsoft.Authorization/roleAssignments/abc',
        resourceId: 'abc',
        publicExposure: 'public',
        serviceHint: 'Owner;principalType=User',
      },
    ];
    const hits = matchAzureAssets(
      { subscriptionId: '11111111-1111-1111-1111-111111111111' },
      assets,
    );
    const found = hits.find((h) => h.cveId === 'AZ-IAM-OVERPERM-001');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('High');
  });

  it('does NOT flag resource-scope Contributor as over-permission', () => {
    const assets: AzureAssetDraft[] = [
      {
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        location: 'subscription-scope',
        resourceType: 'microsoft.authorization/roleassignments',
        resourceArn: '/providers/Microsoft.Authorization/roleAssignments/abc',
        resourceId: 'abc',
        publicExposure: 'private',
        serviceHint: 'Contributor;principalType=User',
      },
    ];
    const hits = matchAzureAssets(
      { subscriptionId: '11111111-1111-1111-1111-111111111111' },
      assets,
    );
    expect(hits).toEqual([]);
  });
});
