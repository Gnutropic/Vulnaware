// @polsia:user-owned — Bearer-token lookup for POST /api/ci/webhook. Resolves
// an inbound `Authorization: Bearer <plaintext>` header into its owning
// team. Resolution order reflects the deploy mode:
//
//   1. env.CI_WEBHOOK_TOKENS_JSON (per-team map for multi-workspace deploys).
//   2. env.CI_WEBHOOK_TOKEN       (single-workspace fallback).
//
// Every compare runs in constant time via timingSafeEqual — a brute-forcer
// can't shave bytes off the wrong-key delay. NEVER replace these calls
// with a `===` string compare; that's the load-bearing security property
// of this file.
//
// Mirrors the posture of src/lib/business/api-keys for X-API-Key, but stays
// strictly env-configured (per the brief's MVP-scoped Wire it up section)
// — no DB row provisioning required.

import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export interface CiWebhookContext {
  ok: true;
  teamId: string;
}

interface TokensJsonMap {
  [teamName: string]: { teamId: string; token: string };
}

// Parsed `CI_WEBHOOK_TOKENS_JSON` shape. Returns null on any malformed input
// — the route surfaces 503 `ci_webhook_token_not_configured` so an operator
// typo becomes a clean cold-deploy signal instead of a silent auth bypass.
// Validation is intentional: a permissive parser would let a token with a
// tail comma still execute the per-team match, which is the wrong posture
// for a config-via-env secret.
function parseTokensJson(raw: string | undefined): TokensJsonMap | null {
  if (!raw || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: TokensJsonMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') return null;
      const v = value as Record<string, unknown>;
      const teamId = v.teamId;
      const token = v.token;
      if (typeof teamId !== 'string' || teamId.length === 0) return null;
      if (typeof token !== 'string' || token.length === 0) return null;
      out[key] = { teamId, token };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Constant-time compare of two strings. Buffers are padded to the same size
 * before timingSafeEqual so a length-mismatch can't be detected from the
 * runtime — the wrapper now runs in time proportional to the longer input.
 * UTF-8 encoded so a non-ASCII bearer compares byte-equivalent to the
 * stored value.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const longer = aBuf.length >= bBuf.length ? aBuf.length : bBuf.length;
  const aPad = Buffer.alloc(longer);
  const bPad = Buffer.alloc(longer);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  return timingSafeEqual(aPad, bPad);
}

/**
 * Resolve a bearer token to its team. Returns:
 *   - `{ ok: true, teamId }` on match.
 *   - `'not_configured'` when no env path is wired (cold deploy).
 *   - `null` when something IS configured but the plaintext doesn't match
 *     (the route maps that to 401).
 */
export async function lookupCiWebhookToken(
  plaintext: string,
): Promise<CiWebhookContext | 'not_configured' | null> {
  const supplied = plaintext;
  if (!supplied || supplied.length === 0) return null;

  const hasAnyEnv = Boolean(env.CI_WEBHOOK_TOKEN) || Boolean(env.CI_WEBHOOK_TOKENS_JSON);

  // 1. Multi-team env map (preferred when set — explicit per-team pin).
  const map = parseTokensJson(env.CI_WEBHOOK_TOKENS_JSON);
  if (map) {
    for (const entry of Object.values(map)) {
      if (constantTimeStringEqual(supplied, entry.token)) {
        return { ok: true, teamId: entry.teamId };
      }
    }
    // Configured but the plaintext didn't match this map — keep searching
    // the single-team fallback below so an operator can run both
    // simultaneously during a cutover.
  }

  // 2. Single-team env token. Pin to the `default` team (the bootstrap
  // name) and fall back to system/first-team if it's been renamed.
  if (env.CI_WEBHOOK_TOKEN) {
    if (constantTimeStringEqual(supplied, env.CI_WEBHOOK_TOKEN)) {
      const team =
        (await prisma.team.findFirst({ where: { name: 'default' } })) ??
        (await prisma.team.findFirst({ where: { name: 'system' } })) ??
        (await prisma.team.findFirst({ select: { id: true } }));
      if (!team) return 'not_configured';
      return { ok: true, teamId: team.id };
    }
  }

  return hasAnyEnv ? null : 'not_configured';
}
