// @polsia:user-owned — Shared types + Azure SDK client factory for the
// discovery modules. Pure TS — no SDK clients in the types so the file can
// be imported by pure tests without pulling in real client SDKs.

import type { AzureAssetItem } from '@/lib/contracts/azure';

/**
 * Loose shape used by the orchestrator before it persists. Mirrors the zod
 * `AzureAssetItem` minus the server-generated id (the orchestrator stamps one
 * after `createMany`).
 */
export type AzureAssetDraft = Pick<
  AzureAssetItem,
  | 'subscriptionId'
  | 'location'
  | 'resourceType'
  | 'resourceArn'
  | 'resourceId'
  | 'publicExposure'
  | 'serviceHint'
>;

/**
 * Stub credential row shape — matches the zod `AzureConnectionCreate`. Used by
 * the orchestrator + enumerators; the orchestrator builds the SDK credential
 * from this via `credentialsFrom`.
 */
export interface AzureCredentialRow {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

/**
 * Marker factory. The actual SDK credential import lives in
 * `run-azure-discovery.ts` because the @azure/identity package is heavy and
 * the rest of the module is pure TS. This file stays a type-only surface so
 * pure tests can import it freely.
 */
export function credentialRowSanity(row: AzureCredentialRow): AzureCredentialRow {
  if (!row.tenantId || !row.clientId || !row.clientSecret || !row.subscriptionId) {
    throw new Error('azure-discovery: incomplete credential row');
  }
  return row;
}
