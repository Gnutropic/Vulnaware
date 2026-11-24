// @vitest-environment node — pure zod contract checks for the Azure surface.
import { describe, expect, it } from 'vitest';
import {
  AzureConnectionCreate,
  AzureConnectionPatch,
  V1AzureDiscoverBody,
} from '@/lib/contracts/azure';

const VALID_GUID = '11111111-1111-1111-1111-111111111111';

describe('AzureConnectionCreate zod', () => {
  it('accepts a valid tenant + client + subscription + secret + label', () => {
    const r = AzureConnectionCreate.safeParse({
      subscriptionId: VALID_GUID,
      tenantId: VALID_GUID,
      clientId: VALID_GUID,
      clientSecret: 'secret-value',
      label: 'Production',
      locations: ['eastus', 'westeurope'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed tenant id', () => {
    const r = AzureConnectionCreate.safeParse({
      subscriptionId: VALID_GUID,
      tenantId: 'not-a-guid',
      clientId: VALID_GUID,
      clientSecret: 'secret-value',
      label: 'Production',
      locations: [],
    });
    expect(r.success).toBe(false);
  });

  it('defaults empty locations to []', () => {
    const r = AzureConnectionCreate.safeParse({
      subscriptionId: VALID_GUID,
      tenantId: VALID_GUID,
      clientId: VALID_GUID,
      clientSecret: 'secret-value',
      label: 'Production',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.locations).toEqual([]);
  });

  it('rejects a too-short label', () => {
    const r = AzureConnectionCreate.safeParse({
      subscriptionId: VALID_GUID,
      tenantId: VALID_GUID,
      clientId: VALID_GUID,
      clientSecret: 'secret-value',
      label: '',
      locations: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('AzureConnectionPatch zod', () => {
  it('accepts a label-only patch', () => {
    const r = AzureConnectionPatch.safeParse({ label: 'Renamed' });
    expect(r.success).toBe(true);
  });

  it('rejects an empty location segment (digits-only)', () => {
    const r = AzureConnectionPatch.safeParse({ locations: ['123'] });
    expect(r.success).toBe(false);
  });
});

describe('V1AzureDiscoverBody zod', () => {
  it('requires a connectionId', () => {
    const r = V1AzureDiscoverBody.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts an optional locations list', () => {
    const r = V1AzureDiscoverBody.safeParse({
      connectionId: 'c-1',
      locations: ['eastus'],
    });
    expect(r.success).toBe(true);
  });
});
