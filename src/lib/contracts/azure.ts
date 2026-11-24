// @polsia:user-owned — Azure asset discovery contracts (pure zod). Imported by
// the /api/azure/** and /api/v1/azure/** route handlers AND the client
// islands; no server-only imports here.

import { z } from 'zod';

// GUID-or-uuid regex matches Azure tenant ids, client ids and subscription
// ids: 8-4-4-4-12 hex OR a 36-char dashed lowercase set. We accept both so
// a typo on the form boundaries becomes a 400, not a silent DB write.
export const AZURE_TENANT_ID = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u,
    'Must be a valid Azure tenant id (GUID)',
  );

export const AZURE_SUBSCRIPTION_ID = AZURE_TENANT_ID;

export const AZURE_CLIENT_ID = AZURE_TENANT_ID;

export const AZURE_CLIENT_SECRET = z.string().min(1).max(256, 'Client secret is too long');

// Azure region slug: e.g. eastus, westeurope, japaneast. Lowercase, no
// digits-only segments, no underscores.
export const AZURE_LOCATION = z
  .string()
  .regex(/^[a-z]+[0-9a-z]*$/u, 'Must be a valid Azure region slug like eastus');

export const AZURE_LOCATION_LIST = z
  .array(AZURE_LOCATION)
  .min(0)
  .max(20, 'At most 20 locations per connection');

// Service-account JSON shape — parsed and structurally validated.
const SERVICE_ACCOUNT_JSON_SCHEMA = z
  .object({
    type: z.literal('service_account'),
    project_id: z.string().min(1),
    client_email: z.string().min(1),
    private_key: z.string().min(1),
  })
  .passthrough();

export const AzureConnectionCreate = z
  .object({
    subscriptionId: AZURE_SUBSCRIPTION_ID,
    tenantId: AZURE_TENANT_ID,
    clientId: AZURE_CLIENT_ID,
    clientSecret: AZURE_CLIENT_SECRET,
    label: z.string().min(1).max(64),
    locations: AZURE_LOCATION_LIST.default([]),
  })
  .superRefine((data, ctx) => {
    // We don't currently cross-validate the secret against Azure — the
    // connection-test endpoint does the live probe at discovery time.
    void data;
    void ctx;
  });

export const AzureConnectionPatch = z.object({
  label: z.string().min(1).max(64).optional(),
  locations: AZURE_LOCATION_LIST.optional(),
});

export const AzureConnectionItem = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  subscriptionId: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  locations: z.array(z.string()),
  createdAt: z.string(),
  lastTestedAt: z.string().nullable(),
});

export const AzureConnectionList = z.object({
  items: z.array(AzureConnectionItem),
});

export const AzureRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);

export const AzureDiscoveryCreateResponse = z.object({
  id: z.string(),
  status: AzureRunStatus,
  pollUrl: z.string(),
});

export const AzureDiscoveryRunItem = z.object({
  id: z.string(),
  connectionId: z.string(),
  status: AzureRunStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  locations: z.array(z.string()),
  resourcesTotal: z.number().int().min(0),
});

export const AzureAssetItem = z.object({
  id: z.string(),
  runId: z.string(),
  subscriptionId: z.string(),
  location: z.string(),
  resourceType: z.string(),
  resourceArn: z.string(),
  resourceId: z.string().nullable(),
  publicExposure: z.enum(['public', 'private', 'unknown']).nullable(),
  serviceHint: z.string().nullable(),
});

export const AzureDiscoveryRunWithAssets = AzureDiscoveryRunItem.extend({
  assets: z.array(AzureAssetItem),
});

export const AzureTestConnectionResponse = z.object({
  ok: z.boolean(),
  subscriptionId: z.string().nullable(),
  // Locations the assumed role has permissions to call `Microsoft.Compute`
  // in. Empty when assume failed.
  reachableLocations: z.array(z.string()),
  errorMessage: z.string().nullable(),
});

export const V1AzureDiscoverBody = z.object({
  connectionId: z.string().min(1),
  locations: AZURE_LOCATION_LIST.optional(),
});

export const V1AzureDiscoverResponse = z.object({
  id: z.string(),
  status: AzureRunStatus,
  pollUrl: z.string(),
});

// Service-account JSON re-exported for the GCP contract.
export { SERVICE_ACCOUNT_JSON_SCHEMA };

export type AzureConnectionCreate = z.infer<typeof AzureConnectionCreate>;
export type AzureConnectionPatch = z.infer<typeof AzureConnectionPatch>;
export type AzureConnectionItem = z.infer<typeof AzureConnectionItem>;
export type AzureRunStatus = z.infer<typeof AzureRunStatus>;
export type AzureDiscoveryCreateResponse = z.infer<typeof AzureDiscoveryCreateResponse>;
export type AzureDiscoveryRunItem = z.infer<typeof AzureDiscoveryRunItem>;
export type AzureAssetItem = z.infer<typeof AzureAssetItem>;
export type AzureDiscoveryRunWithAssets = z.infer<typeof AzureDiscoveryRunWithAssets>;
export type AzureTestConnectionResponse = z.infer<typeof AzureTestConnectionResponse>;
export type V1AzureDiscoverBody = z.infer<typeof V1AzureDiscoverBody>;
export type V1AzureDiscoverResponse = z.infer<typeof V1AzureDiscoverResponse>;
