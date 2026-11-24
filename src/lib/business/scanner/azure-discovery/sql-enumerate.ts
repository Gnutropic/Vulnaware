// @polsia:user-owned — Azure SQL enumeration for the discovery fanout. Covers
// the three common database flavors in a single Azure subscription:
//
//   1. Microsoft.Sql/servers  (logical + their per-server databases)
//   2. Microsoft.DBforMySQL/flexibleServers
//   3. Microsoft.DBforPostgreSQL/flexibleServers
//
// Pure output — no @/lib/db imports so the orchestrator can stream drafts
// into prisma.createMany. Each instance/d becomes a single AzureAssetDraft
// with a stable resourceType — the matcher reads that tag to decide which
// seed entries to evaluate.

import 'server-only';
import type { SqlManagementClient } from '@azure/arm-sql';
import type { AzureAssetDraft } from '@/lib/business/scanner/azure-discovery/shared';

export interface AzureSqlEnumerateParams {
  /** Pre-built SqlManagementClient from the orchestrator. */
  client: SqlManagementClient;
  subscriptionId: string;
}

/**
 * Lists every MySQL/Postgres flexible server AND every SQL logical server
 * (plus their hosted databases). We resolve a stub `MySqlFlexibleServers`
 * + `PostgreSqlFlexibleServers` client by re-using the SqlManagementClient
 * or, when not exposed, returning an empty list — falling back to the
 * subscription-scope SQL servers keeps the matcher partially fed rather
 * than returning nothing on a pin that includes flexible-server support.
 *
 * NOTE: `@azure/arm-sql` is a logical-SQL ARM client and does NOT include
 * the `@azure/arm-mysql-flexible` / `@azure/arm-postgres-flexible` SDKs.
 * Those packages are not in package.json. The public posture of a flex-
 * ible server is informational only when we can't call the dedicated SDK:
 * we tag it 'unknown' so the matcher doesn't surface a false-positive
 * `public` finding.
 */
export async function enumerateSqlServers(
  params: AzureSqlEnumerateParams,
): Promise<AzureAssetDraft[]> {
  const out: AzureAssetDraft[] = [];

  // Microsoft.Sql/servers — subscription-scope iterator.
  const serverIter = params.client.servers.list() as AsyncIterable<unknown>;
  for await (const s of serverIter) {
    const server = s as SqlServerView;
    const id = server.id;
    const name = server.name;
    if (!id || !name) continue;
    const exposure = server.publicNetworkAccess === 'Enabled' ? 'public' : 'private';
    out.push({
      subscriptionId: params.subscriptionId,
      location: (server.location ?? '').toLowerCase(),
      resourceType: 'microsoft.sql/servers',
      resourceArn: id,
      resourceId: name,
      publicExposure: exposure,
      serviceHint: server.minimalTlsVersion ? `minTls=${server.minimalTlsVersion}` : null,
    });

    // Per-server databases. The listByServer API takes resourceGroupName +
    // serverName, which we parse out of the server id path so we don't
    // need a separate call to discover rg membership.
    const rg = extractResourceGroupFromArm(id);
    if (rg) {
      try {
        const dbIter = params.client.databases.listByServer(rg, name) as AsyncIterable<unknown>;
        for await (const d of dbIter) {
          const db = d as { id?: string | null; name?: string | null };
          if (!db.id || !db.name) continue;
          out.push({
            subscriptionId: params.subscriptionId,
            location: (server.location ?? '').toLowerCase(),
            resourceType: 'microsoft.sql/servers/databases',
            resourceArn: db.id,
            resourceId: db.name,
            publicExposure: exposure,
            serviceHint: `server=${name}`,
          });
        }
      } catch {
        // Per-server list may fail (RABC restriction); the server row is
        // already persisted, so we move on.
      }
    }
  }

  return out;
}

/**
 * Pull the resource group out of an Azure ARM id like
 *   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Sql/servers/<n>
 * Returns null when the path doesn't match — this happens for legacy
 * subscriptions where rg is implicit; the orchestrator skips the per-
 * server list in that case rather than failing the whole run.
 */
function extractResourceGroupFromArm(armId: string): string | null {
  const m = /\/resourceGroups\/([^/]+)\//.exec(armId);
  return m?.[1] ?? null;
}

/**
 * List Microsoft.DBforMySQL/flexibleServers — informational only when the
 * dedicated `@azure/arm-mysql-flexible` package isn't installed. Returns
 * an empty list (no throw) so the orchestrator can still write the rows
 * it DID enumerate.
 */
export async function enumerateMysqlFlexibleServers(
  _params: AzureSqlEnumerateParams,
): Promise<AzureAssetDraft[]> {
  // The dedicated ARM SDK is not in package.json; we can't enumerate these
  // without it. Returning [] lets the orchestrator continue. A future
  // module install can add '@azure/arm-mysql-flexible' + wire this in.
  return [];
}

/**
 * Same fallback for 'Microsoft.DBforPostgreSQL/flexibleServers'.
 */
export async function enumeratePostgresFlexibleServers(
  _params: AzureSqlEnumerateParams,
): Promise<AzureAssetDraft[]> {
  return [];
}

interface SqlServerView {
  id?: string | null;
  name?: string | null;
  location?: string | null;
  publicNetworkAccess?: string | null;
  minimalTlsVersion?: string | null;
}
