// @vitest-environment node — pure zod contract checks for the GCP surface.
import { describe, expect, it } from 'vitest';
import { GcpConnectionCreate, GcpConnectionPatch, V1GcpDiscoverBody } from '@/lib/contracts/gcp';

const VALID_SA = JSON.stringify({
  type: 'service_account',
  project_id: 'my-project',
  client_email: 'sa@my-project.iam.gserviceaccount.com',
  private_key: 'REDACTED\n',
});

describe('GcpConnectionCreate zod', () => {
  it('accepts a valid project + service-account JSON + zones', () => {
    const r = GcpConnectionCreate.safeParse({
      projectId: 'my-project',
      serviceAccountJson: VALID_SA,
      label: 'Production',
      zones: ['us-central1-a', 'europe-west1-b'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid project id', () => {
    const r = GcpConnectionCreate.safeParse({
      projectId: 'X', // too short, uppercase
      serviceAccountJson: VALID_SA,
      label: 'Production',
      zones: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a service-account JSON whose project_id does not match the connection id', () => {
    const parsed = JSON.parse(VALID_SA) as Record<string, string>;
    parsed.project_id = 'other-project';
    const mismatched = JSON.stringify(parsed);
    const r = GcpConnectionCreate.safeParse({
      projectId: 'my-project',
      serviceAccountJson: mismatched,
      label: 'Production',
      zones: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a service-account JSON that is not typed service_account', () => {
    // Replace via JSON round-trip so we don't have to know JSON.stringify's
    // exact spacing.
    const parsed = JSON.parse(VALID_SA) as Record<string, string>;
    parsed.type = 'authorized_user';
    const notSa = JSON.stringify(parsed);
    const r = GcpConnectionCreate.safeParse({
      projectId: 'my-project',
      serviceAccountJson: notSa,
      label: 'Production',
      zones: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const r = GcpConnectionCreate.safeParse({
      projectId: 'my-project',
      serviceAccountJson: 'not json',
      label: 'Production',
      zones: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed zone slug', () => {
    const r = GcpConnectionCreate.safeParse({
      projectId: 'my-project',
      serviceAccountJson: VALID_SA,
      label: 'Production',
      zones: ['nope'],
    });
    expect(r.success).toBe(false);
  });
});

describe('GcpConnectionPatch zod', () => {
  it('accepts a zones-only patch', () => {
    const r = GcpConnectionPatch.safeParse({ zones: ['us-central1-a'] });
    expect(r.success).toBe(true);
  });
});

describe('V1GcpDiscoverBody zod', () => {
  it('requires a connectionId', () => {
    const r = V1GcpDiscoverBody.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts an optional zones list', () => {
    const r = V1GcpDiscoverBody.safeParse({
      connectionId: 'c-1',
      zones: ['us-central1-a'],
    });
    expect(r.success).toBe(true);
  });
});
