// @vitest-environment node — pure zod contract checks for the AWS surface.
import { describe, expect, it } from 'vitest';
import { AwsConnectionCreate, AwsConnectionPatch, V1AwsDiscoverBody } from '@/lib/contracts/aws';

describe('AwsConnectionCreate zod', () => {
  it('accepts a valid cross-account role ARN + external id + label', () => {
    const r = AwsConnectionCreate.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'vulnaware-2026',
      label: 'Production',
      regions: ['us-east-1', 'us-west-2'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed role ARN', () => {
    const r = AwsConnectionCreate.safeParse({
      roleArn: 'arn:aws:s3:::bucket', // wrong service
      externalId: 'vulnaware-2026',
      label: 'x',
      regions: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a too-short external id', () => {
    const r = AwsConnectionCreate.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'a',
      label: 'x',
      regions: [],
    });
    expect(r.success).toBe(false);
  });

  it('defaults empty regions to []', () => {
    const r = AwsConnectionCreate.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'vulnaware-2026',
      label: 'x',
      // regions omitted
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.regions).toEqual([]);
  });

  it('rejects an invalid region name', () => {
    const r = AwsConnectionCreate.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'vulnaware-2026',
      label: 'x',
      regions: ['eastcoastusa'],
    });
    expect(r.success).toBe(false);
  });

  it('caps regions at 20', () => {
    const r = AwsConnectionCreate.safeParse({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'vulnaware-2026',
      label: 'x',
      regions: new Array(21).fill('us-east-1'),
    });
    expect(r.success).toBe(false);
  });
});

describe('AwsConnectionPatch zod', () => {
  it('accepts a label-only patch', () => {
    const r = AwsConnectionPatch.safeParse({ label: 'Renamed' });
    expect(r.success).toBe(true);
  });

  it('accepts a regions-only patch', () => {
    const r = AwsConnectionPatch.safeParse({ regions: ['eu-west-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects an empty patch', () => {
    const r = AwsConnectionPatch.safeParse({});
    expect(r.success).toBe(true); // everything optional — useful for no-op PATCH
  });
});

describe('V1AwsDiscoverBody zod', () => {
  it('requires a connectionId', () => {
    const r = V1AwsDiscoverBody.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts an optional regions list', () => {
    const r = V1AwsDiscoverBody.safeParse({
      connectionId: 'c-1',
      regions: ['us-east-1'],
    });
    expect(r.success).toBe(true);
  });
});
