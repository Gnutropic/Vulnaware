// @polsia:user-owned — Shared types + AWS SDK client factory for the
// discovery modules. Not server-only on its own (a value type module);
// every importer below imports 'server-only'.

import type { AwsAssetItem } from '@/lib/contracts/aws';

/**
 * Loose shape used by the orchestrator before it persists. Mirrors the zod
 * `AwsAssetItem` minus the server-generated id (the orchestrator stamps one
 * after `createMany`). Imported as a TYPE only by the orchestrator so the
 * raw business output stays plain TS.
 */
export type AwsAssetDraft = Pick<
  AwsAssetItem,
  | 'accountId'
  | 'region'
  | 'resourceType'
  | 'resourceArn'
  | 'resourceId'
  | 'publicExposure'
  | 'serviceHint'
>;

/** Credentials returned by `assumeRole`; reused across the discovery modules. */
export interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Compose the credentials object the AWS SDK clients accept. Kept tiny so
 * future SDKs (e.g. `RDS`, `Lambda`) reuse the same factory.
 */
export function credentialsFrom(obj: AssumedCredentials): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} {
  return {
    accessKeyId: obj.accessKeyId,
    secretAccessKey: obj.secretAccessKey,
    sessionToken: obj.sessionToken,
  };
}
