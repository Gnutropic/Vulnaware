// @polsia:user-owned — Scoped API key helpers. Pure scrypt-based hashing
// (`<saltHex>$<hashHex>`) so plaintext secrets are never persisted. Also the
// idempotent system-team bootstrap (`attachSystemTeamIfMissing`) — when the
// DB has zero Team rows we seed one system team + backfill legacy scans; this
// preserves the legacy `VULN_API_KEY` env without breaking existing CI/CD
// callers.

import 'server-only';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ApiKey } from '@prisma/client';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

// scrypt cost factor used for ALL key hashes. Hard-coded so verify can
// reproduce the same parameters from the stored hash string alone.
// (Node's promisified scrypt signature: (password, salt, keylen[, options]).
// Cost is encoded in the options arg OR overridden by setting SCRYPT_PARAMS;
// we pick explicit defaults to avoid platform drift.) N is the CPU/memory cost
// (2^14 = 16384, the Node default).
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

export type ScopeKind = 'team' | 'scan';

export interface CreatedApiKey {
  /** The persisted row (without plaintext hash). */
  record: ApiKey;
  /** Plaintext secret — returned ONCE on create. Never persisted. */
  plaintext: string;
}

/**
 * Generate a fresh API key. Plaintext (`crypto.randomBytes(32).toString('base64url')`)
 * is returned to the caller exactly once; only the scrypt-derived hash is
 * stored on the row.
 */
export function generatePlaintextSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a plaintext key into the stored form: "<saltHex>$<hashHex>".
 * Uses scrypt with explicit cost params so verify reproduces them.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(plaintext, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
  return `${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Parse "<saltHex>$<hashHex>" into its parts. Returns null on malformed input
 * (length-mismatch stored hashes are treated as malformed, not as wrong-key —
 * a wrong-length hash is a corrupt row, not an auth failure).
 */
function parseStoredHash(stored: string): { salt: Buffer; hash: Buffer } | null {
  const ix = stored.indexOf('$');
  if (ix < 0) return null;
  const saltHex = stored.slice(0, ix);
  const hashHex = stored.slice(ix + 1);
  if (saltHex.length !== 32 || hashHex.length !== SCRYPT_KEYLEN * 2) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || hash.length === 0) return null;
  return { salt, hash };
}

/**
 * Constant-time verify: re-derive with scrypt using the row's salt, then
 * `timingSafeEqual` on the derived-byte buffers (always equal length — 64
 * bytes). Never use string `===` — that short-circuits on the first mismatch
 * and leaks length + position. The constant-time compare is the load-bearing
 * property of this whole file.
 */
export async function verifyApiKeyHash(plaintext: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(plaintext, parsed.salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
  // Both buffers are SCRYPT_KEYLEN long — timingSafeEqual's equal-length
  // precondition is met by construction.
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Create a row. Returns the persisted record + one-time plaintext. Caller is
 * responsible for surfacing the plaintext to the end user exactly once.
 */
export async function createApiKey(params: {
  name: string;
  teamId: string;
  scopeKind: ScopeKind;
  scanId: string | null;
}): Promise<CreatedApiKey> {
  const plaintext = generatePlaintextSecret();
  const hash = await hashApiKey(plaintext);
  const record = await prisma.apiKey.create({
    data: {
      name: params.name,
      hash,
      teamId: params.teamId,
      scopeKind: params.scopeKind,
      scanId: params.scanId,
    },
  });
  return { record, plaintext };
}

/**
 * Idempotent first-boot seed: if the Team table is empty AND `env.VULN_API_KEY`
 * is set, create a `system` team + a team-scope key whose hash derives from
 * `VULN_API_KEY`. Backfills `Scan.teamId` to the new team so legacy scans
 * become owned (so existing CI/CD consumers keep working without redeploy).
 *
 * Race-safe: the gate is "Team count === 0"; only the first caller wins. On
 * `findFirst` race the loser sees the row already created and short-circuits.
 *
 * Called from `verifyApiKey` so a cold deploy without `VULN_API_KEY` still
 * falls through to 503 (avoids one-touch seeding under the wrong context).
 */
let bootstrapPromise: Promise<void> | null = null;
export function attachSystemTeamIfMissing(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = doAttachSystemTeamIfMissing().catch(() => {
    // If the seed fails (e.g. transient deadlock), allow a retry on the next
    // request — clear the cached promise so the next call retries.
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

async function doAttachSystemTeamIfMissing(): Promise<void> {
  const count = await prisma.team.count();
  if (count > 0) return;
  const seed = env.VULN_API_KEY;
  if (!seed) return; // cold deploy w/o env key — verifyApiKey will emit 503.

  // Use a raw upsert by name (system team is unique). If a concurrent caller
  // already inserted it, this no-ops.
  const team = await prisma.team.upsert({
    where: { name: 'system' },
    update: {},
    create: { name: 'system' },
  });

  // Seed a single team-scope key for VULN_API_KEY if not already present.
  // We compute the hash of the seed plaintext once — if multiple keys with
  // different salts collide on the same plaintext (extremely unlikely with a
  // fresh salt per row) each one verifies against its own hash.
  const existing = await prisma.apiKey.findFirst({ where: { teamId: team.id } });
  if (!existing) {
    const hash = await hashApiKey(seed);
    await prisma.apiKey.create({
      data: {
        name: 'system-default',
        hash,
        teamId: team.id,
        scopeKind: 'team',
        scanId: null,
      },
    });
  }

  // Backfill legacy scans so the seed key sees them. Done unconditionally on
  // first boot — for an empty Team table this is the only possible state and
  // is what legacy CI/CD callers rely on.
  await prisma.scan.updateMany({
    where: { teamId: null },
    data: { teamId: team.id },
  });
}

/**
 * Look up a key by id within a team. Returns null for foreign-team rows so
 * the route handler can return 404 (never reveal existence cross-team).
 * Already-revoked rows are still observable here — the caller decides
 * posture.
 */
export async function getApiKeyById(id: string, teamId: string): Promise<ApiKey | null> {
  return prisma.apiKey.findFirst({ where: { id, teamId } });
}

/**
 * Stamp `lastUsedAt` after a successful verify. Best-effort — does NOT throw
 * on the hot path (failure to stamp is non-fatal). Awaited inline so tests
 * can assert against it.
 */
export async function markApiKeyUsed(id: string): Promise<void> {
  try {
    await prisma.apiKey.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  } catch {
    // Swallow — observability is best-effort and must never block a verified
    // request.
  }
}

/**
 * Soft-revoke a key (set `revokedAt`). Caller is responsible for 404/409
 * posture against the response of `getApiKeyById`.
 */
export async function revokeApiKey(id: string, teamId: string): Promise<ApiKey | null> {
  const row = await prisma.apiKey.findFirst({ where: { id, teamId } });
  if (!row) return null;
  if (row.revokedAt) return row;
  return prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}
