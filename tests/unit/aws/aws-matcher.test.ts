// @vitest-environment node — AWS matcher is pure TS; no DOM needed.
import { describe, expect, it } from 'vitest';
import { matchAwsAssets } from '@/lib/business/scanner/aws-discovery/aws-matcher';
import type { AwsAssetDraft } from '@/lib/business/scanner/aws-discovery/shared';

describe('matchAwsAssets — seed table', () => {
  it('flags a public S3 bucket as Critical', () => {
    const assets: AwsAssetDraft[] = [
      {
        accountId: '111111111111',
        region: 'us-east-1',
        resourceType: 's3:bucket',
        resourceArn: 'arn:aws:s3:::leaky-bucket',
        resourceId: 'leaky-bucket',
        publicExposure: 'public',
        serviceHint: null,
      },
    ];
    const hits = matchAwsAssets({ accountId: '111111111111' }, assets);
    const critical = hits.find((h) => h.cveId === 'AWS-S3-PUBLIC-001');
    expect(critical).toBeDefined();
    expect(critical?.severity).toBe('Critical');
    expect(critical?.matchReason).toContain('111111111111');
  });

  it('does NOT flag a private S3 bucket', () => {
    const assets: AwsAssetDraft[] = [
      {
        accountId: '111111111111',
        region: 'us-east-1',
        resourceType: 's3:bucket',
        resourceArn: 'arn:aws:s3:::private-bucket',
        resourceId: 'private-bucket',
        publicExposure: 'private',
        serviceHint: null,
      },
    ];
    const hits = matchAwsAssets({ accountId: '111111111111' }, assets);
    expect(hits).toEqual([]);
  });

  it('flags a public EC2 instance as High', () => {
    const assets: AwsAssetDraft[] = [
      {
        accountId: 'acct',
        region: 'us-east-1',
        resourceType: 'ec2:instance',
        resourceArn: 'arn:aws:ec2:us-east-1:acct:instance/i-abc',
        resourceId: 'i-abc',
        publicExposure: 'public',
        serviceHint: null,
      },
    ];
    const hits = matchAwsAssets({ accountId: 'acct' }, assets);
    expect(hits.find((h) => h.cveId === 'AWS-EC2-EXPOSED-001')).toBeDefined();
  });

  it('flags a non-compliant Config roll-up as High', () => {
    const assets: AwsAssetDraft[] = [
      {
        accountId: 'acct',
        region: 'us-east-1',
        resourceType: 'config:compliance',
        resourceArn: 'arn:aws:config:us-east-1:acct:config-rule/compliance-summary',
        resourceId: 'compliance-summary',
        publicExposure: 'public',
        serviceHint: 'iam-root-access-key, iam-password-policy',
      },
    ];
    const hits = matchAwsAssets({ accountId: 'acct' }, assets);
    expect(hits.find((h) => h.cveId === 'AWS-CONFIG-NONCOMPLIANT-001')).toBeDefined();
  });

  it('flags an IAM account that permits access keys', () => {
    const assets: AwsAssetDraft[] = [
      {
        accountId: 'acct',
        region: 'aws-global',
        resourceType: 'iam:account',
        resourceArn: 'arn:aws:iam::acct:account/acct',
        resourceId: 'acct',
        publicExposure: 'private',
        serviceHint: 'users=3;mfa=1;accessKeysPerUser=2',
      },
    ];
    const hits = matchAwsAssets({ accountId: 'acct' }, assets);
    expect(hits.find((h) => h.cveId === 'AWS-IAM-LEGACY-KEY-001')).toBeDefined();
  });

  it('does NOT flag an IAM account that bans access keys', () => {
    const assets: AwsAssetDraft[] = [
      {
        accountId: 'acct',
        region: 'aws-global',
        resourceType: 'iam:account',
        resourceArn: 'arn:aws:iam::acct:account/acct',
        resourceId: 'acct',
        publicExposure: 'private',
        serviceHint: 'users=0;mfa=0;accessKeysPerUser=0',
      },
    ];
    const hits = matchAwsAssets({ accountId: 'acct' }, assets);
    expect(hits).toEqual([]);
  });
});
