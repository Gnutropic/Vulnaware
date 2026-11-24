// @polsia:user-owned — Azure RBAC role-assignment enumeration. Lists role
// assignments scoped to the subscription and surfaces an
// `microsoft.authorization/roleassignments` asset per owner-class
// assignment (Owner / Contributor at the subscription scope) — the matcher
// reads `serviceHint` to determine over-permission and emits a finding.

import 'server-only';
import type { AuthorizationManagementClient } from '@azure/arm-authorization';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

export interface AzureRbacParams {
  subscriptionId: string;
  client: AuthorizationManagementClient;
}

interface RoleAssignmentView {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  properties?: {
    roleDefinitionId?: string | null;
    principalId?: string | null;
    principalType?: string | null;
    scope?: string | null;
  } | null;
}

export async function enumerateRoleAssignments(
  params: AzureRbacParams,
): Promise<AzureAssetDraft[]> {
  const out: AzureAssetDraft[] = [];
  const scope = `/subscriptions/${params.subscriptionId}`;
  // listForSubscription() returns a paged async iterable — first page is
  // typically all of them for a single-subscription scan.
  const iter =
    params.client.roleAssignments.listForSubscription() as AsyncIterable<RoleAssignmentView>;
  for await (const ra of iter) {
    if (!ra.id || !ra.properties) continue;
    const roleDef = ra.properties.roleDefinitionId ?? '';
    const roleKind = classifyRole(roleDef);
    if (roleKind === null) continue;
    const isSubScope = (ra.properties.scope ?? '').toLowerCase() === scope.toLowerCase();
    out.push({
      subscriptionId: params.subscriptionId,
      location: 'subscription-scope',
      resourceType: 'microsoft.authorization/roleassignments',
      resourceArn: ra.id,
      resourceId: ra.name ?? null,
      publicExposure: isSubScope ? 'public' : 'private',
      serviceHint: `${roleKind};principalType=${ra.properties.principalType ?? 'unknown'}`,
    });
  }
  return out;
}

function classifyRole(roleDefinitionId: string): 'Owner' | 'Contributor' | null {
  // b24988ac-6180-42a0-ab88-20f7382dd24c = Contributor;
  // 8e3af657-a8ff-443c-a75c-2fe8c4bcb635 = Owner.
  const m =
    /\/providers\/Microsoft\.Authorization\/\/roles\/(b24988ac-6180-42a0-ab88-20f7382dd24c|8e3af657-a8ff-443c-a75c-2fe8c4bcb635)($|\.)/i.exec(
      roleDefinitionId,
    );
  if (!m) return null;
  return m[1]?.toLowerCase() === '8e3af657-a8ff-443c-a75c-2fe8c4bcb635' ? 'Owner' : 'Contributor';
}
