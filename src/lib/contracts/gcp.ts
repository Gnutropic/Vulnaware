// @polsia:user-owned — GCP asset discovery contracts (pure zod). Imported by
// the /api/gcp/** and /api/v1/gcp/** route handlers AND the client islands; no
// server-only imports here.

import { z } from 'zod';
import { SERVICE_ACCOUNT_JSON_SCHEMA } from '@/lib/contracts/azure';

// GCP project ids: lowercase letters / digits / dashes, must START with a
// letter, 6-30 chars total.
export const GCP_PROJECT_ID = z
  .string()
  .regex(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/u, 'Must be a valid GCP project id');

// GCP zone slug: e.g. us-central1-a, europe-west2-b. Lowercase letters, a
// digit segment, a zone letter at the end.
export const GCP_ZONE = z
  .string()
  .regex(/^[a-z]+-[a-z]+\d+-[a-z]$/u, 'Must be a valid GCP zone slug like us-central1-a');

export const GCP_ZONE_LIST = z.array(GCP_ZONE).min(0).max(20, 'At most 20 zones per connection');

const SERVICE_ACCOUNT_JSON_STRING = z
  .string()
  .min(1)
  .transform((raw: string, ctx: z.RefinementCtx): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return z.NEVER;
    }
    const r = SERVICE_ACCOUNT_JSON_SCHEMA.safeParse(parsed);
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['serviceAccountJson', ...issue.path],
          message: issue.message,
        });
      }
      return z.NEVER;
    }
    return raw;
  });

const SA_PAYLOAD = z
  .object({
    type: z.string().optional(),
    project_id: z.string().optional(),
  })
  .passthrough();

export const GcpConnectionCreate = z
  .object({
    projectId: GCP_PROJECT_ID,
    serviceAccountJson: SERVICE_ACCOUNT_JSON_STRING,
    label: z.string().min(1).max(64),
    zones: GCP_ZONE_LIST.default([]),
  })
  .refine(
    (data) => {
      // Cross-field: the SA-JSON's project_id must equal the connection's
      // projectId and the type must be service_account. (Both are already
      // structurally validated by SERVICE_ACCOUNT_JSON_SCHEMA for the type,
      // but the project_id match is genuinely cross-field.)
      try {
        const parsed = SA_PAYLOAD.parse(JSON.parse(data.serviceAccountJson));
        if (parsed.type !== 'service_account') return false;
        return parsed.project_id === data.projectId;
      } catch {
        return false;
      }
    },
    {
      path: ['serviceAccountJson'],
      message:
        'Service-account JSON must be a service_account key whose project_id matches the connection',
    },
  );

export const GcpConnectionPatch = z.object({
  label: z.string().min(1).max(64).optional(),
  zones: GCP_ZONE_LIST.optional(),
});

export const GcpConnectionItem = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  projectId: z.string(),
  zones: z.array(z.string()),
  createdAt: z.string(),
  lastTestedAt: z.string().nullable(),
});

export const GcpConnectionList = z.object({
  items: z.array(GcpConnectionItem),
});

export const GcpRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);

export const GcpDiscoveryCreateResponse = z.object({
  id: z.string(),
  status: GcpRunStatus,
  pollUrl: z.string(),
});

export const GcpDiscoveryRunItem = z.object({
  id: z.string(),
  connectionId: z.string(),
  status: GcpRunStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  projectId: z.string().nullable(),
  zones: z.array(z.string()),
  resourcesTotal: z.number().int().min(0),
});

export const GcpAssetItem = z.object({
  id: z.string(),
  runId: z.string(),
  projectId: z.string(),
  zone: z.string(),
  resourceType: z.string(),
  resourceArn: z.string(),
  resourceId: z.string().nullable(),
  publicExposure: z.enum(['public', 'private', 'unknown']).nullable(),
  serviceHint: z.string().nullable(),
});

export const GcpDiscoveryRunWithAssets = GcpDiscoveryRunItem.extend({
  assets: z.array(GcpAssetItem),
});

export const GcpTestConnectionResponse = z.object({
  ok: z.boolean(),
  projectId: z.string().nullable(),
  reachableZones: z.array(z.string()),
  errorMessage: z.string().nullable(),
});

export const V1GcpDiscoverBody = z.object({
  connectionId: z.string().min(1),
  zones: GCP_ZONE_LIST.optional(),
});

export const V1GcpDiscoverResponse = z.object({
  id: z.string(),
  status: GcpRunStatus,
  pollUrl: z.string(),
});

export type GcpConnectionCreate = z.infer<typeof GcpConnectionCreate>;
export type GcpConnectionPatch = z.infer<typeof GcpConnectionPatch>;
export type GcpConnectionItem = z.infer<typeof GcpConnectionItem>;
export type GcpRunStatus = z.infer<typeof GcpRunStatus>;
export type GcpDiscoveryCreateResponse = z.infer<typeof GcpDiscoveryCreateResponse>;
export type GcpDiscoveryRunItem = z.infer<typeof GcpDiscoveryRunItem>;
export type GcpAssetItem = z.infer<typeof GcpAssetItem>;
export type GcpDiscoveryRunWithAssets = z.infer<typeof GcpDiscoveryRunWithAssets>;
export type GcpTestConnectionResponse = z.infer<typeof GcpTestConnectionResponse>;
export type V1GcpDiscoverBody = z.infer<typeof V1GcpDiscoverBody>;
export type V1GcpDiscoverResponse = z.infer<typeof V1GcpDiscoverResponse>;
