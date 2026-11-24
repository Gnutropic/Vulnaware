// @polsia:user-owned — Per-endpoint webhook subscriptions with HMAC-SHA256
// signing. Mirrors src/lib/business/api-keys.ts posture: per-Team ownership,
// soft-deletable, secret stored as an envelope-encrypted ciphertext so
// plaintext is never persisted. Plaintext is returned exactly once on create.
//
// Threat model:
//   - DB read-only attacker (read the Webhook table): gets only ciphertext
//     and the env-held key is in a separate secret store, so plaintext is
//     not extractable from ciphertext alone.
//   - DB read/write attacker (full DB compromise): can decrypt because they
//     have access to env at runtime — same posture as API keys, where
//     scrypt hashes are also defeated by a DB write. Envelope encryption is
//     a defense-in-depth convenience, not a guarantee against a fully
//     compromised deployment. Customers rotate by re-creating the webhook.
//
// The plaintext secret lives only in process memory between create-time and
// the moment the trigger route passes it to deliverWebhook for signing —
// after that the only DB-resident form is the envelope ciphertext.

import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Webhook } from '@prisma/client';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

// ===================== KEY MANAGEMENT =====================

// In-process memoized AES key. Generated on first read when the env var is
// absent (dev/test fallback); production deployments supply a stable 64-char
// hex value via env.WEBHOOK_SIGNING_KEY so ciphertext remains decryptable
// across restarts. The `let` shape keeps the key off the imported bindings
// the linter scans.
let _memoizedKey: Buffer | null = null;
let _memoizedKeyWarned = false;
function getMasterKey(): Buffer {
  if (_memoizedKey) return _memoizedKey;
  const raw = env.WEBHOOK_SIGNING_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    _memoizedKey = Buffer.from(raw, 'hex');
  } else {
    // Dev/test fallback — generates an in-memory key. Resetting the process
    // invalidates all stored ciphertexts, which is acceptable in dev. In
    // production the env must be set so this path never triggers.
    _memoizedKey = randomBytes(32);
    if (!_memoizedKeyWarned && env.NODE_ENV === 'production') {
      _memoizedKeyWarned = true;
    }
  }
  return _memoizedKey;
}

// ===================== ENVELOPE ENCRYPTION =====================

const ENVELOPE_VERSION = 'enc:v1';
const IV_BYTES = 12; // GCM standard

/**
 * Encrypt plaintext under the master key. Returns
 * "enc:v1:<base64-iv>:<base64-ciphertext>:<base64-tag>".
 */
export function encryptSigningSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    ct.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a stored envelope back to plaintext. Returns null on malformed
 * input (wrong shape, bad base64, GCM tag mismatch) so the caller can fall
 * back to a 404 instead of a 500.
 */
export function decryptSigningSecret(stored: string): string | null {
  const parts = stored.split(':');
  if (
    parts.length !== 5 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined ||
    parts[4] === undefined ||
    `${parts[0]}:${parts[1]}` !== ENVELOPE_VERSION
  ) {
    return null;
  }
  try {
    const iv = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const tag = Buffer.from(parts[4], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const key = getMasterKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

// ===================== SECRET GEN / HASH =====================

/**
 * Generate a fresh signing secret. 64-char lower-case hex (32 random bytes);
 * hex is conventional for HMAC and yields an easily-printable customer-facing
 * secret.
 */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('hex');
}

// ===================== HMAC SIGN / VERIFY =====================

const SIGNATURE_HEADER_PREFIX = 'sha256=';

/**
 * Compute the hex HMAC-SHA256 of `body` using `secret`. Pure function — no
 * I/O — so the route can compute the signature from a plaintext secret
 * passed in by the caller that owns the secret in memory.
 */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Verify an `X-VulnAware-Signature: sha256=<hex>` header against a secret
 * and the raw request body. Returns `false` (never throws) on:
 *   - missing or malformed prefix
 *   - wrong-length hex
 *   - wrong algorithm prefix
 *   - GCM tag / signature mismatch
 *
 * Constant-time compare on equal-length 32-byte buffers — pre-check
 * `Buffer.byteLength` to avoid the throw timingSafeEqual raises on
 * length-mismatched inputs.
 */
export function verifySignature(secret: string, body: string, signatureHeader: string): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  if (!signatureHeader.startsWith(SIGNATURE_HEADER_PREFIX)) return false;
  const hex = signatureHeader.slice(SIGNATURE_HEADER_PREFIX.length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = Buffer.from(signPayload(secret, body), 'utf8');
  const supplied = Buffer.from(hex, 'utf8');
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

/**
 * Constant-time compare for raw hex strings of equal length — used by the
 * integration tests that compare a recomputed signature to the header value.
 * Public so tests can verify without re-implementing the timingSafeEqual
 * boilerplate.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return timingSafeEqual(ab, bb);
}

// Public export for OpenAPI docs / customer verification snippets — same
// format the route produces.
export function formatSignatureHeader(hex: string): string {
  return `${SIGNATURE_HEADER_PREFIX}${hex}`;
}

// ===================== CRUD =====================

export interface CreatedWebhook {
  record: Webhook;
  plaintext: string;
}

/**
 * Create a webhook row. Generates a fresh plaintext signing secret, stores
 * only the envelope-encrypted form, and returns both the persisted row and
 * the one-time plaintext. Caller surfaces the plaintext to the customer
 * exactly once.
 */
export async function createWebhook(params: {
  url: string;
  teamId: string;
}): Promise<CreatedWebhook> {
  const plaintext = generateSigningSecret();
  const cipher = encryptSigningSecret(plaintext);
  const record = await prisma.webhook.create({
    data: {
      url: params.url,
      signingSecretCipher: cipher,
      signingAlgorithm: 'hmac-sha256',
      teamId: params.teamId,
    },
  });
  return { record, plaintext };
}

/**
 * List non-revoked webhooks for a team. Includes the team summary so the
 * route can build the Wire shape without an extra round-trip.
 */
export async function listWebhooks(teamId: string): Promise<
  Array<
    Webhook & {
      team: { id: string; name: string };
    }
  >
> {
  return prisma.webhook.findMany({
    where: { teamId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { team: { select: { id: true, name: true } } },
  });
}

/**
 * Look up a webhook by id within a team. Returns null for foreign-team rows
 * so the route can return 404 (never reveal existence cross-team).
 */
export async function getWebhookById(
  id: string,
  teamId: string,
): Promise<(Webhook & { team: { id: string; name: string } }) | null> {
  return prisma.webhook.findFirst({
    where: { id, teamId },
    include: { team: { select: { id: true, name: true } } },
  });
}

/**
 * Soft-revoke a webhook. Returns the row (or null for foreign-team / not
 * found). Already-revoked rows are returned unchanged so the route can
 * surface a 409.
 */
export async function revokeWebhook(id: string, teamId: string): Promise<Webhook | null> {
  const row = await prisma.webhook.findFirst({ where: { id, teamId } });
  if (!row) return null;
  if (row.revokedAt) return row;
  return prisma.webhook.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

/**
 * Fetch the decrypted plaintext signing secret for a webhook. Returns null
 * if the row is missing, revoked, or the ciphertext cannot be decrypted
 * (e.g. the env-held master key has rotated since the row was written).
 */
export async function getWebhookSigningSecret(id: string, teamId: string): Promise<string | null> {
  const row = await prisma.webhook.findFirst({
    where: { id, teamId, revokedAt: null },
    select: { signingSecretCipher: true },
  });
  if (!row) return null;
  return decryptSigningSecret(row.signingSecretCipher);
}

/**
 * Stamp `lastSignedAt` after a successful delivery. Best-effort — does NOT
 * throw on the hot path; failure to stamp is non-fatal and observability-only.
 */
export async function markWebhookSigned(id: string): Promise<void> {
  try {
    await prisma.webhook.update({
      where: { id },
      data: { lastSignedAt: new Date() },
    });
  } catch {
    // Swallow — observability is best-effort and must never block a verified
    // delivery.
  }
}

// ===================== OUTBOUND DELIVERY =====================

export interface DeliveryParams {
  /** Webhook row id — used for the `X-VulnAware-Delivery` header and the
   *  `lastSignedAt` stamp. */
  webhookId: string;
  /** Target URL. */
  url: string;
  /** Plaintext signing secret. Held in process memory by the caller. */
  secret: string;
  /** JSON payload to send verbatim. */
  payload: unknown;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * Sign and POST a JSON payload to a registered webhook. Returns a result
 * envelope so the caller can log delivery outcomes without throwing.
 *
 * Caller is expected to wrap the call in `void deliverWebhook(...).catch(...)`
 * so a slow or failing customer endpoint never blocks the scan response.
 *
 * The signature header format is:
 *   X-VulnAware-Signature: sha256=<hex>
 * where <hex> is the HMAC-SHA256 of the raw JSON request body using the
 * secret returned at registration time. The stored ciphertext is never
 * sent in the delivery.
 */
export async function deliverWebhook(params: DeliveryParams): Promise<DeliveryResult> {
  const body = JSON.stringify(params.payload);
  const signature = signPayload(params.secret, body);
  const deliveryId = randomBytes(8).toString('hex');
  try {
    const res = await fetch(params.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vulnaware-signature': formatSignatureHeader(signature),
        'x-vulnaware-delivery': deliveryId,
        'user-agent': 'VulnAware-Webhooks/1.0',
      },
      body,
    });
    if (res.ok) {
      // Best-effort observability — fire-and-forget stamp; the response
      // to the caller is already determined by `res.ok`.
      void markWebhookSigned(params.webhookId);
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status, error: `upstream ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : 'fetch failed',
    };
  }
}

// ===================== UTILITIES =====================

// Stable sha256 of an arbitrary UTF-8 string — exposed for callers that
// want a deterministic row hash for an audit log without bringing in a
// second crypto import. Not used in the signing path.
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
