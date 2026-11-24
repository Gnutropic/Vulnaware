// @polsia:user-owned — Inbound webhook signature verification. Pin-by-id
// (the caller must also send a per-team `X-Webhook-Id` header) so the
// verifier does at most one decrypt + one HMAC compare per request, regardless
// of how many webhook rows the team has registered.
//
// Threat model:
//   - Id pin prevents the verifier from leaking which webhooks a team has via
//     timing (one DB query, constant-time hex compare). Foreign-team rows are
//     returned as "missing" so the route stays 401-uniform.
//   - Decrypt uses the same envelope ciphertext + env-held master key as the
//     outbound `deliverWebhook` (`src/lib/business/webhooks.ts`). Plaintext
//     does not leave process memory.
//   - Missing/foreign/revoked row → null. The route maps null → 401 with the
//     same `{error:"unauthorized"}` envelope the api-key gate uses, so SIEM
//     parsers continue to discriminate 401 from 403.

import 'server-only';
import { decryptSigningSecret, verifySignature } from '@/lib/business/webhooks';
import { prisma } from '@/lib/db';

export interface VerifyInboundParams {
  rawBody: string;
  /** Header value (case-insensitive already lower-cased by the runtime). */
  signatureHeader: string;
  /** Cuid of the Webhook row to pin against. */
  webhookId: string;
  /** Owning team — foreign-team rows are treated as missing. */
  teamId: string;
}

export interface VerifiedWebhook {
  /** The verified, non-revoked webhook row (cipher stripped). */
  webhook: {
    id: string;
    url: string;
    teamId: string;
    signingAlgorithm: string;
    lastSignedAt: Date | null;
    createdAt: Date;
    revokedAt: Date | null;
  };
}

/**
 * Verify an inbound HMAC-SHA256 signature against the single
 * non-revoked `Webhook` row matching (id, teamId). Returns `null` for
 * every failure mode (missing row, revoked row, foreign team,
 * decrypt-fail, header malformed, signature mismatch). Pure beyond the
 * one DB lookup so it can be unit-tested with a mocked `prisma.webhook`.
 */
export async function verifyInboundWebhook(
  params: VerifyInboundParams,
): Promise<VerifiedWebhook | null> {
  const row = await prisma.webhook.findFirst({
    where: { id: params.webhookId, teamId: params.teamId, revokedAt: null },
  });
  if (!row) return null;

  // Algorithm gate — today only hmac-sha256 is supported. A future scheme
  // (e.g. hmac-sha512) would branch here.
  if (row.signingAlgorithm !== 'hmac-sha256') return null;

  const plaintext = decryptSigningSecret(row.signingSecretCipher);
  if (plaintext === null) return null;

  if (!verifySignature(plaintext, params.rawBody, params.signatureHeader)) return null;

  return {
    webhook: {
      id: row.id,
      url: row.url,
      teamId: row.teamId,
      signingAlgorithm: row.signingAlgorithm,
      lastSignedAt: row.lastSignedAt,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
    },
  };
}
