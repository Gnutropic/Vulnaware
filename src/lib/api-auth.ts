// @polsia:user-owned — DB-backed scoped API key authentication for the
// /api/v1/** enterprise endpoints. Replaces the previous env-string compare
// with a Prisma lookup + scrypt verify. Preserves the original fail-closed
// posture: missing/wrong key → 401; absent bootstrap → 503.
//
// Each successful verify attaches the `{ teamId, scopeKind, scanId | null,
// keyId }` context a handler threads into every read/write so foreign-team
// reads get 403, `scan`-scope keys can't list scans, and trigger writes land
// under the bearing key's team.
//
// proxy.ts matcher excludes /api/* from middleware, so this helper is the
// single source of inline auth for every v1 handler. The constant-time
// compare (in src/lib/business/api-keys) is load-bearing — never replace it
// with string `===`.

import 'server-only';
import { NextResponse } from 'next/server';
import type { ScopeKind } from '@/lib/business/api-keys';
import {
  attachSystemTeamIfMissing,
  markApiKeyUsed,
  verifyApiKeyHash,
} from '@/lib/business/api-keys';
import { prisma } from '@/lib/db';

const HEADER_NAME = 'x-api-key';

export interface ApiKeyContext {
  ok: true;
  teamId: string;
  scopeKind: ScopeKind;
  scanId: string | null;
  keyId: string;
}

/**
 * Verify an X-API-Key header against the `ApiKey` table.
 *
 * Returns a NextResponse on failure (401 / 503), or `{ ok: true, ... }` on
 * success. Every v1 handler follows the same pattern:
 *   const auth = await verifyApiKey(req);
 *   if (auth instanceof NextResponse) return auth;
 *   const ctx = auth; // ApiKeyContext
 *
 * Posture:
 *   503 `api_key_not_configured` → DB is empty AND there is no env seed AND
 *     no bootstrap has run (cold deploy misconfiguration must be surfaced).
 *   401 `unauthorized` → any other failure (missing header, malformed
 *     plaintext, wrong key, revoked key).
 *
 * Side-effect: stamps `lastUsedAt` on the row (best-effort, swallow).
 */
export async function verifyApiKey(req: Request): Promise<NextResponse | ApiKeyContext> {
  await attachSystemTeamIfMissing();

  const supplied = req.headers.get(HEADER_NAME);
  if (!supplied || supplied.length === 0) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // First reachability check — if no rows exist at all AND the env seed
  // bootstrapped a row (attachSystemTeamIfMissing is awaited above), emit
  // 503. Actually since the bootstrap seeds a row when VULN_API_KEY is set,
  // reaching `verifyApiKeyHash` is enough; we still gate on `count === 0`
  // below to keep the cold-deploy-without-env posture identical to before.
  const rowCount = await prisma.apiKey.count();
  if (rowCount === 0) {
    return NextResponse.json({ error: 'api_key_not_configured' }, { status: 503 });
  }

  // Single round-trip — load every non-revoked row, then constant-time
  // verify against each stored hash. The cardinality is bounded to the
  // number of API keys issued by this tenant (handful to a few hundred at
  // most); per-row scrypt is fine. If the tenant grows past that, switch
  // to a salt-prefixed index lookup (key → row).
  const rows = await prisma.apiKey.findMany({
    where: { revokedAt: null },
    select: { id: true, hash: true, teamId: true, scopeKind: true, scanId: true },
  });

  for (const row of rows) {
    // Short-circuit on success so a stale row's slow scrypt doesn't block
    // the hot path. The verify it's never timingSafe-equal between plaintext
    // lengths (the stored hash is always 32+128 hex chars), so we don't need
    // a length pre-check at the plaintext boundary.
    // eslint-disable-next-line no-await-in-loop -- sequential verify is intentional
    const ok = await verifyApiKeyHash(supplied, row.hash);
    if (!ok) continue;

    // scopeKind is stored as a String column — narrow before returning so
    // the handler gets a typed union, not an arbitrary string.
    const scopeKind: ScopeKind = row.scopeKind === 'scan' ? 'scan' : 'team';

    // best-effort observability stamp
    void markApiKeyUsed(row.id);

    return {
      ok: true,
      teamId: row.teamId,
      scopeKind,
      scanId: row.scanId ?? null,
      keyId: row.id,
    };
  }

  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
