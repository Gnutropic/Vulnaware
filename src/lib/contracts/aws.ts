// @polsia:user-owned — AWS asset discovery contracts (pure zod). Imported by
// the /api/aws/** and /api/v1/aws/** route handlers AND the client islands; no
// server-only imports here.

import { z } from 'zod';

// ARN shape: `arn:<partition>:<service>:<region>:<account>:...`. We don't
// constrain the trailing resource portion (different per service), but the
// prefix is required so a typo can't slip into the DB.
export const AWS_ROLE_ARN = z
  .string()
  .min(20)
  .regex(/^arn:(aws[a-z-]*)?:iam::\d{12}:role\/.+$/u, 'Must be a valid IAM role ARN');

// External id is opaque up to 1224 chars per AWS docs. Required when the
// customer sets one; the contract accepts empty but downstream lambdas/tests
// can branch on presence.
export const AWS_EXTERNAL_ID = z
  .string()
  .min(2)
  .max(1224)
  .regex(/^[A-Za-z0-9_+=,.@:\-/]+$/u, 'External id contains disallowed characters');

// Region lookup — strict (lowercase ISO code, no cross-region assembled names).
export const AWS_REGION = z
  .string()
  .regex(/^[a-z]{2}(-[a-z]+)+-\d$/u, 'Must be a valid AWS region name like us-east-1');

export const AWS_REGION_LIST = z
  .array(AWS_REGION)
  .min(0)
  .max(20, 'At most 20 regions per connection');

export const AwsConnectionCreate = z.object({
  roleArn: AWS_ROLE_ARN,
  externalId: AWS_EXTERNAL_ID,
  label: z.string().min(1).max(64),
  regions: AWS_REGION_LIST.default([]),
});

export const AwsConnectionPatch = z.object({
  label: z.string().min(1).max(64).optional(),
  regions: AWS_REGION_LIST.optional(),
});

export const AwsConnectionItem = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  roleArn: z.string(),
  regions: z.array(z.string()),
  createdAt: z.string(),
  lastTestedAt: z.string().nullable(),
});

export const AwsConnectionList = z.object({
  items: z.array(AwsConnectionItem),
});

// Status mirrors the strings stored on AwsDiscoveryRun.status (String column).
export const AwsRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);

export const AwsDiscoveryCreateResponse = z.object({
  id: z.string(),
  status: AwsRunStatus,
  pollUrl: z.string(),
});

export const AwsDiscoveryRunItem = z.object({
  id: z.string(),
  connectionId: z.string(),
  status: AwsRunStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  accountId: z.string().nullable(),
  regions: z.array(z.string()),
  resourcesTotal: z.number().int().min(0),
});

export const AwsAssetItem = z.object({
  id: z.string(),
  runId: z.string(),
  accountId: z.string(),
  region: z.string(),
  resourceType: z.string(),
  resourceArn: z.string(),
  resourceId: z.string().nullable(),
  publicExposure: z.enum(['public', 'private', 'unknown']).nullable(),
  serviceHint: z.string().nullable(),
});

export const AwsDiscoveryRunWithAssets = AwsDiscoveryRunItem.extend({
  assets: z.array(AwsAssetItem),
});

// Connection-test response: STS + a one-region EC2 reach probe so the caller
// sees whether enumeration will work in practice, not just the assume.
export const AwsTestConnectionResponse = z.object({
  ok: z.boolean(),
  accountId: z.string().nullable(),
  // Regions the assumed role has permissions to call `ec2:DescribeInstances`
  // in. Empty when AssumeRole failed.
  reachableRegions: z.array(z.string()),
  errorMessage: z.string().nullable(),
});

// AWS-discovery scope entry surface (v1 enterprise). Same create shape — just
// expresses which connection id the call refers to and (optionally) pin a
// region set the call wants enumerated; defaults to the connection's regions.
export const V1AwsDiscoverBody = z.object({
  connectionId: z.string().min(1),
  regions: AWS_REGION_LIST.optional(),
});

export const V1AwsDiscoverResponse = z.object({
  id: z.string(),
  status: AwsRunStatus,
  pollUrl: z.string(),
});

export type AwsConnectionCreate = z.infer<typeof AwsConnectionCreate>;
export type AwsConnectionPatch = z.infer<typeof AwsConnectionPatch>;
export type AwsConnectionItem = z.infer<typeof AwsConnectionItem>;
export type AwsRunStatus = z.infer<typeof AwsRunStatus>;
export type AwsDiscoveryCreateResponse = z.infer<typeof AwsDiscoveryCreateResponse>;
export type AwsDiscoveryRunItem = z.infer<typeof AwsDiscoveryRunItem>;
export type AwsAssetItem = z.infer<typeof AwsAssetItem>;
export type AwsDiscoveryRunWithAssets = z.infer<typeof AwsDiscoveryRunWithAssets>;
export type AwsTestConnectionResponse = z.infer<typeof AwsTestConnectionResponse>;
export type V1AwsDiscoverBody = z.infer<typeof V1AwsDiscoverBody>;
export type V1AwsDiscoverResponse = z.infer<typeof V1AwsDiscoverResponse>;
