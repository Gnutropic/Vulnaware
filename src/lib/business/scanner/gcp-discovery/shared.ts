// @polsia:user-owned — Shared types + GCP discovery-row shape. Pure TS — no
// SDK clients in the types so the file can be imported by pure tests.

import type { GcpAssetItem } from '@/lib/contracts/gcp';

/**
 * Loose shape used by the orchestrator before it persists. Mirrors the zod
 * `GcpAssetItem` minus the server-generated id.
 */
export type GcpAssetDraft = Pick<
  GcpAssetItem,
  | 'projectId'
  | 'zone'
  | 'resourceType'
  | 'resourceArn'
  | 'resourceId'
  | 'publicExposure'
  | 'serviceHint'
>;

/**
 * Stub credential row shape — matches the zod `GcpConnectionCreate`. Used by
 * the orchestrator + enumerators; the actual `GoogleAuth.fromJSON` factory
 * lives inside the orchestrator because the @google-cloud SDK is heavy.
 */
export interface GcpCredentialRow {
  projectId: string;
  serviceAccountJson: string;
}

export function credentialRowSanity(row: GcpCredentialRow): GcpCredentialRow {
  if (!row.projectId || !row.serviceAccountJson) {
    throw new Error('gcp-discovery: incomplete credential row');
  }
  return row;
}
