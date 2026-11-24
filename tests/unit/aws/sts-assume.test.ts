// @vitest-environment node — STS AssumeRole wrapper test. We inject a fake
// client so the call doesn't depend on network access.
import { describe, expect, it, vi } from 'vitest';

// 'server-only' is a Next.js marker that vitest cannot resolve; stub it
// with an empty module so the assumeRole source file loads in tests.
vi.mock('server-only', () => ({}));

import { assumeRole } from '@/lib/business/scanner/aws-discovery/sts-assume';

interface AssumeRoleInput {
  RoleArn: string;
  RoleSessionName: string;
  ExternalId: string;
}

interface FakeCommand {
  input: AssumeRoleInput;
}

interface FakeSts {
  send: ReturnType<typeof vi.fn>;
}

function makeFakeSts(impl: (cmd: FakeCommand) => Promise<unknown>): FakeSts {
  return { send: vi.fn(async (cmd: FakeCommand) => impl(cmd)) };
}

describe('assumeRole', () => {
  it('calls STS with role ARN, external id, and the default session name', async () => {
    let capturedCmd: FakeCommand | null = null;
    const stub = makeFakeSts(async (cmd) => {
      capturedCmd = cmd;
      return {
        Credentials: {
          AccessKeyId: 'AKIA-TEST',
          SecretAccessKey: 'SECRET-TEST',
          SessionToken: 'TOKEN-TEST',
          Expiration: new Date('2030-01-01T00:00:00Z'),
        },
      };
    });
    await assumeRole({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'ext-1',
      region: 'us-east-1',
      stsClient: stub as never,
    });
    expect(stub.send).toHaveBeenCalledTimes(1);
    expect(capturedCmd).not.toBeNull();
    const sent = capturedCmd as unknown as FakeCommand;
    expect(sent.input).toMatchObject({
      RoleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      RoleSessionName: 'vulnaware-discovery',
      ExternalId: 'ext-1',
    });
  });

  it('returns the temporary credentials verbatim (never persisted)', async () => {
    const stub = makeFakeSts(async () => ({
      Credentials: {
        AccessKeyId: 'AKIA-TEST',
        SecretAccessKey: 'SECRET-TEST',
        SessionToken: 'TOKEN-TEST',
        Expiration: new Date('2030-01-01T00:00:00Z'),
      },
    }));
    const out = await assumeRole({
      roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
      externalId: 'ext-1',
      region: 'us-east-1',
      stsClient: stub as never,
    });
    expect(out.accessKeyId).toBe('AKIA-TEST');
    expect(out.secretAccessKey).toBe('SECRET-TEST');
    expect(out.sessionToken).toBe('TOKEN-TEST');
    expect(out.accountId).toBe('123456789012');
  });

  it('throws when STS returns no credentials', async () => {
    const stub = makeFakeSts(async () => ({ Credentials: undefined }));
    await expect(
      assumeRole({
        roleArn: 'arn:aws:iam::123456789012:role/VulnAwareScanner',
        externalId: 'ext-1',
        region: 'us-east-1',
        stsClient: stub as never,
      }),
    ).rejects.toThrow(/no credentials/i);
  });
});
