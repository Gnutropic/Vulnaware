// @polsia:user-owned — GCP IAM policy reader. Reads the IAM policy of the
// project itself (Resource Manager v3) so the matcher can flag over-
// permission. We only emit ONE `cloudresourcemanager.googleapis.com/Project`
// asset per project; the serviceHint encodes the over-permission shape so
// the matcher doesn't need to re-fetch.

import 'server-only';
import type { GcpAssetDraft } from '@/lib/business/scanner/gcp-discovery/shared';

export interface GcpIamParams {
  projectId: string;
  client: {
    getIamPolicy: () => Promise<GcpIamPolicy>;
  };
}

interface GcpIamBinding {
  role?: string | null;
  members?: string[] | null;
}

interface GcpIamPolicy {
  bindings?: GcpIamBinding[] | null;
  etag?: string | null;
}

const PRIVILEGED_ROLES = new Set([
  'roles/owner',
  'roles/editor', // legacy — appears in older projects.
]);

export async function enumerateProjectIam(params: GcpIamParams): Promise<GcpAssetDraft[]> {
  let policy: GcpIamPolicy = {};
  try {
    policy = await params.client.getIamPolicy();
  } catch {
    return [];
  }

  const overPermCount = countOverPermissive(policy);
  const publicExposure: 'public' | 'private' = overPermCount > 0 ? 'public' : 'private';

  return [
    {
      projectId: params.projectId,
      zone: 'global',
      resourceType: 'cloudresourcemanager.googleapis.com/Project',
      resourceArn: `projects/${params.projectId}`,
      resourceId: params.projectId,
      publicExposure,
      serviceHint:
        overPermCount > 0
          ? `overPermissive=${overPermCount};roles=${Array.from(PRIVILEGED_ROLES).join(',')}`
          : `roles_restricted=${PRIVILEGED_ROLES.size}`,
    },
  ];
}

function countOverPermissive(policy: GcpIamPolicy): number {
  let n = 0;
  for (const b of policy.bindings ?? []) {
    if (!b.role || !PRIVILEGED_ROLES.has(b.role)) continue;
    for (const m of b.members ?? []) {
      // count wildcards + external members as over-permission signals.
      if (m === 'allUsers' || m === 'allAuthenticatedUsers' || m.startsWith('user:')) n += 1;
    }
  }
  return n;
}
