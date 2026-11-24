// @polsia:user-owned — Unified /api/cloud** contracts (pure zod, no server-
// only imports). Same provider enum and credential shapes the per-provider
// contracts already export — discriminated unions + cross-references keep
// this in lockstep with aws.ts/azure.ts/gcp.ts.

import { z } from 'zod';
import { AWS_EXTERNAL_ID, AWS_REGION_LIST, AWS_ROLE_ARN } from '@/lib/contracts/aws';
import {
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  AZURE_LOCATION_LIST,
  AZURE_SUBSCRIPTION_ID,
  AZURE_TENANT_ID,
} from '@/lib/contracts/azure';
import { GCP_PROJECT_ID, GCP_ZONE_LIST } from '@/lib/contracts/gcp';

// Re-export the provider enum so client islands can avoid pulling the
// cloud-discovery schedule contract just to get the three values.
export const CloudDiscoverProvider = z.enum(['aws', 'azure', 'gcp']);
export type CloudDiscoverProvider = z.infer<typeof CloudDiscoverProvider>;

// ── Connection-input payloads (provider-tagged create shapes) ──────────────

const AwsCredentialsInput = z.object({
  roleArn: AWS_ROLE_ARN,
  externalId: AWS_EXTERNAL_ID,
  label: z.string().min(1).max(64),
  regions: AWS_REGION_LIST.default([]),
});

const AzureCredentialsInput = z.object({
  subscriptionId: AZURE_SUBSCRIPTION_ID,
  tenantId: AZURE_TENANT_ID,
  clientId: AZURE_CLIENT_ID,
  clientSecret: AZURE_CLIENT_SECRET,
  label: z.string().min(1).max(64),
  locations: AZURE_LOCATION_LIST.default([]),
});

const GcpCredentialsInput = z.object({
  projectId: GCP_PROJECT_ID,
  // The full service-account JSON; the connection form does its own
  // server-side validation. Here we only sanitize shape (non-empty).
  serviceAccountJson: z.string().min(1).max(16_000),
  label: z.string().min(1).max(64),
  zones: GCP_ZONE_LIST.default([]),
});

const AwsConnectionIdRef = z.object({
  provider: z.literal('aws'),
  connectionId: z.string().min(1),
});

const AzureConnectionIdRef = z.object({
  provider: z.literal('azure'),
  connectionId: z.string().min(1),
});

const GcpConnectionIdRef = z.object({
  provider: z.literal('gcp'),
  connectionId: z.string().min(1),
});

const AwsCredentialsShape = AwsCredentialsInput.extend({ provider: z.literal('aws') });
const AzureCredentialsShape = AzureCredentialsInput.extend({ provider: z.literal('azure') });
const GcpCredentialsShape = GcpCredentialsInput.extend({ provider: z.literal('gcp') });

// POST /api/cloud/discover — accepts EITHER a credentials payload (the
// route creates + persists the connection, then queues a run) OR an
// existing connectionId (the route queues a run without writing a row).
// Discriminator is the literal provider field, but BOTH shapes share it
// per-provider — so z.discriminatedUnion('provider', [...]) is invalid
// (duplicate `aws` etc). We use z.union instead and narrow at the route
// handler boundary via key-presence checks (`'connectionId' in body`).
export const CloudUnifiedDiscoverRequest = z.union([
  AwsCredentialsShape,
  AwsConnectionIdRef,
  AzureCredentialsShape,
  AzureConnectionIdRef,
  GcpCredentialsShape,
  GcpConnectionIdRef,
]);
export type CloudUnifiedDiscoverRequest = z.infer<typeof CloudUnifiedDiscoverRequest>;

// POST response — discriminator on `provider` so the client island can do
// the right navigation without inspecting the connection independently.
export const CloudDiscoveryResponse = z.object({
  id: z.string(),
  provider: CloudDiscoverProvider,
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  pollUrl: z.string(),
  connectionId: z.string(),
});
export type CloudDiscoveryResponse = z.infer<typeof CloudDiscoveryResponse>;

// ── GET /api/cloud/runs/[id] body ──────────────────────────────────────────

const CloudRunRingfence = z.object({
  id: z.string(),
  connectionId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  resourcesTotal: z.number().int().min(0),
});

const AWS_RESOURCE_KIND = z.enum([
  'ec2:instance',
  's3:bucket',
  'iam:account',
  'config:compliance',
  'aws:rds:db',
  'aws:rds:cluster',
  'aws:dynamodb:table',
  'aws:ec2:vpc',
  'aws:ec2:subnet',
  'aws:ec2:securitygroup',
  'aws:resource-explorer:*',
]);

const AZURE_RESOURCE_KIND = z.enum([
  'microsoft.compute/virtualmachines',
  'microsoft.storage/storageaccounts',
  'microsoft.authorization/roleassignments',
  'microsoft.sql/servers',
  'microsoft.sql/servers/databases',
  'microsoft.dbformysql/flexibleservers',
  'microsoft.dbforpostgresql/flexibleservers',
  'microsoft.network/virtualnetworks',
  'microsoft.network/networksecuritygroups',
]);

const GCP_RESOURCE_KIND = z.enum([
  'compute.googleapis.com/Instance',
  'storage.googleapis.com/Bucket',
  'cloudresourcemanager.googleapis.com/Project',
  'sqladmin.googleapis.com/Instance',
  'compute.googleapis.com/Network',
  'compute.googleapis.com/Subnetwork',
  'compute.googleapis.com/Firewall',
]);

export const CloudAssetExposureEnum = z.enum(['public', 'private', 'unknown']);

const CloudNormalizedAssetBase = z.object({
  id: z.string(),
  resourceType: z.string(),
  resourceArn: z.string(),
  resourceId: z.string().nullable(),
  location: z.string(),
  exposure: CloudAssetExposureEnum,
  serviceHint: z.string().nullable(),
});

export const AwsNormalizedAssetItem = CloudNormalizedAssetBase.extend({
  provider: z.literal('aws'),
  kind: AWS_RESOURCE_KIND,
  accountId: z.string(),
});
export const AzureNormalizedAssetItem = CloudNormalizedAssetBase.extend({
  provider: z.literal('azure'),
  kind: AZURE_RESOURCE_KIND,
  subscriptionId: z.string(),
});
export const GcpNormalizedAssetItem = CloudNormalizedAssetBase.extend({
  provider: z.literal('gcp'),
  kind: GCP_RESOURCE_KIND,
  projectId: z.string(),
});

export const CloudNormalizedAssetItem = z.discriminatedUnion('provider', [
  AwsNormalizedAssetItem,
  AzureNormalizedAssetItem,
  GcpNormalizedAssetItem,
]);
export type CloudNormalizedAssetItem = z.infer<typeof CloudNormalizedAssetItem>;

export const CloudNormalizedAssetList = z.object({
  provider: CloudDiscoverProvider,
  runId: z.string(),
  items: z.array(CloudNormalizedAssetItem),
});
export type CloudNormalizedAssetList = z.infer<typeof CloudNormalizedAssetList>;

// CloudRunRow — used by /api/cloud/runs/[id] response, also discriminated
// per provider so the client can pick the right asset schema. We re-use
// the per-provider *WithAssets contracts for fidelity OR collapse to a
// normalized shape here; collapsed is fine since the resolver chooses
// based on the `provider` discriminator.

export const CloudRunItem = CloudRunRingfence.extend({
  provider: CloudDiscoverProvider,
  // Each provider has its own asset schema; consumer (client island) reads
  // the right one.
  assets: z.array(z.unknown()),
});
export type CloudRunItem = z.infer<typeof CloudRunItem>;

export const CloudRunDetails = z.object({
  provider: CloudDiscoverProvider,
  run: CloudRunItem,
  findings: z.number().int().min(0).optional(),
});
export type CloudRunDetails = z.infer<typeof CloudRunDetails>;

// ── GET /api/cloud/environments body ───────────────────────────────────────

export const CloudEnvironmentItem = z.object({
  provider: CloudDiscoverProvider,
  connectionId: z.string(),
  connectionLabel: z.string(),
  // ISO strings (or null when no successful run yet).
  lastScanAt: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']).nullable(),
  // Aggregate count of assets written by the last run, useful for the UI.
  resourceCount: z.number().int().min(0),
  // Set to a string when lastScanAt is non-null and the run is `succeeded`
  // or `failed`; otherwise null so the UI can render an "open run" link.
  runId: z.string().nullable(),
});
export type CloudEnvironmentItem = z.infer<typeof CloudEnvironmentItem>;

export const CloudEnvironmentsList = z.object({ items: z.array(CloudEnvironmentItem) });
export type CloudEnvironmentsList = z.infer<typeof CloudEnvironmentsList>;
