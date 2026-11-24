// @polsia:user-owned — sliding-window rate limiter for /api/v1/*.
//
// Bucket key derivation (auth-agnostic, runs before the inner handler):
//   1. SHA-256 of `x-api-key` header value — per-key bucket, no DB lookup.
//   2. SHA-256 of `better-auth.session_token` cookie value — session-gated routes.
//   3. Normalized client IP from `x-forwarded-for` — public /docs and /openapi.json.
//
// Category:
//   tighter (10/min): POST /api/v1/keys, DELETE /api/v1/keys/*, POST /api/v1/webhooks
//   write   (20/min): any non-GET/HEAD/OPTIONS method not matched by tighter
//   read    (60/min): GET, HEAD, OPTIONS
//
// Persistence: Prisma `RateLimitBucket` rows, keyed by SHA-256 hex + "::" + epoch-minute.
// Hot path: 1-second in-process LRU Map (Map w/ LRU eviction on size > 10_000).
// GC: fire-and-forget deleteMany every ~500 increments.

import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

// ── In-process cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  count: number;
  windowStart: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 1000;
const MAX_CACHE_SIZE = 10_000;
const GC_INTERVAL = 500;

// Module-scoped mutable state. Cleared by resetRateLimitStateForTest() in tests.
let cache = new Map<string, CacheEntry>();
let incrementCounter = 0;

// ── SHA-256 helper ────────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── Bucket key derivation ─────────────────────────────────────────────────────

export function deriveBucketKey(req: Request): string {
  // 1. API key header
  const apiKey = req.headers.get('x-api-key');
  if (apiKey && apiKey.length > 0) {
    return sha256hex(`apikey:${apiKey}`);
  }

  // 2. Session cookie (better-auth)
  const cookieHeader = req.headers.get('cookie') ?? '';
  const sessionToken = parseCookieValue(cookieHeader, 'better-auth.session_token');
  if (sessionToken) {
    return sha256hex(`session:${sessionToken}`);
  }

  // 3. Client IP fallback
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded ? (forwarded.split(',')[0] ?? 'unknown').trim() : 'unknown';
  return sha256hex(`ip:${ip}`);
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === name) {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

// ── Category derivation ───────────────────────────────────────────────────────

// Paths that get tighter limits on non-safe methods.
const TIGHTER_PATHS = new Set(['/api/v1/keys', '/api/v1/webhooks', '/api/ci/webhook']);
const TIGHTER_PATH_PREFIX_DELETE = '/api/v1/keys/';

export function deriveCategory(req: Request): 'read' | 'write' | 'tighter' {
  const method = req.method.toUpperCase();

  // Safe methods are always read.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return 'read';
  }

  // Tighter: POST to keys or webhooks root; DELETE on any keys/* path.
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, ''); // strip trailing slash

  if (method === 'POST' && TIGHTER_PATHS.has(path)) {
    return 'tighter';
  }
  if (method === 'DELETE' && path.startsWith(TIGHTER_PATH_PREFIX_DELETE)) {
    return 'tighter';
  }

  return 'write';
}

// ── Sliding-window increment ──────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number; // ms epoch
}

async function runGc(currentMinute: number): Promise<void> {
  try {
    await prisma.rateLimitBucket.deleteMany({
      where: { windowStart: { lt: currentMinute - 2 } },
    });
  } catch {
    // GC is best-effort — never let it surface to the caller.
  }
}

export async function checkAndIncrement(key: string, limit: number): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const currentMinute = Math.floor(nowMs / 60_000);
  const bucketKey = `${key}::${currentMinute}`;
  const resetAt = (currentMinute + 1) * 60_000;

  // ── Hot path: in-process cache ──
  const cached = cache.get(bucketKey);
  if (cached && nowMs - cached.fetchedAt < CACHE_TTL_MS && cached.windowStart === currentMinute) {
    // Optimistic increment in cache — real count might be higher from other
    // replicas, but we use cache to avoid hammering DB on every request.
    cached.count += 1;
    cached.fetchedAt = nowMs;
    return { allowed: cached.count <= limit, count: cached.count, limit, resetAt };
  }

  // ── Cold path: Prisma upsert ──
  incrementCounter += 1;
  if (incrementCounter >= GC_INTERVAL) {
    incrementCounter = 0;
    void runGc(currentMinute);
  }

  let row: { windowStart: number; count: number };

  try {
    row = await prisma.rateLimitBucket.upsert({
      where: { key: bucketKey },
      create: { key: bucketKey, windowStart: currentMinute, count: 1 },
      update: { count: { increment: 1 } },
      select: { windowStart: true, count: true },
    });
  } catch {
    // DB unavailable — fail open (return allowed) but skip caching.
    return { allowed: true, count: 0, limit, resetAt };
  }

  // If the returned row belongs to a stale window (race: two replicas raced
  // to create the row for different minutes), issue a fresh create for the
  // correct minute. This is an edge case that only fires during the exact
  // minute boundary — tolerate by re-upserting.
  if (row.windowStart !== currentMinute) {
    try {
      row = await prisma.rateLimitBucket.upsert({
        where: { key: bucketKey },
        create: { key: bucketKey, windowStart: currentMinute, count: 1 },
        update: { count: { increment: 1 } },
        select: { windowStart: true, count: true },
      });
    } catch {
      return { allowed: true, count: 0, limit, resetAt };
    }
  }

  // Evict stale cache entries if we're near the cap.
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }

  cache.set(bucketKey, { count: row.count, windowStart: currentMinute, fetchedAt: nowMs });

  return { allowed: row.count <= limit, count: row.count, limit, resetAt };
}

// ── withRateLimit wrapper ─────────────────────────────────────────────────────

function rateLimitDisabledResponse(inner: Response, _limit: number): Response {
  const out = new Response(inner.body, {
    status: inner.status,
    statusText: inner.statusText,
    headers: inner.headers,
  });
  out.headers.set('RateLimit-Limit', '0');
  out.headers.set('RateLimit-Remaining', '0');
  out.headers.set('RateLimit-Reset', '0');
  return out;
}

export async function withRateLimit(
  req: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const enabled = env.RATE_LIMIT_ENABLED !== 'false';

  if (!enabled) {
    const inner = await handler();
    return rateLimitDisabledResponse(inner, 0);
  }

  const category = deriveCategory(req);
  const limit =
    category === 'tighter'
      ? env.RATE_LIMIT_TIGHTER_PER_MIN
      : category === 'write'
        ? env.RATE_LIMIT_WRITE_PER_MIN
        : env.RATE_LIMIT_READ_PER_MIN;

  const bucketKey = deriveBucketKey(req);
  const result = await checkAndIncrement(bucketKey, limit);

  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    return new Response(JSON.stringify({ error: 'rate_limited', retryAfter }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'RateLimit-Limit': String(limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
        'Retry-After': String(retryAfter),
      },
    });
  }

  const inner = await handler();

  const out = new Response(inner.body, {
    status: inner.status,
    statusText: inner.statusText,
    headers: inner.headers,
  });
  out.headers.set('RateLimit-Limit', String(limit));
  out.headers.set('RateLimit-Remaining', String(Math.max(0, limit - result.count)));
  out.headers.set('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  return out;
}

// ── Test isolation ────────────────────────────────────────────────────────────

export function resetRateLimitStateForTest(): void {
  if (process.env.NODE_ENV === 'production') return;
  cache = new Map();
  incrementCounter = 0;
}
