// @vitest-environment node
// Unit tests for the rate-limit core (src/lib/rate-limit.ts).
// Covers bucket-key derivation, category derivation, and the sliding-window
// increment path. Mocks @/lib/db (Prisma) and server-only so no real DB
// connection is required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    rateLimitBucket: {
      upsert,
      deleteMany,
    },
  },
}));

const ENV: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_READ_PER_MIN: '60',
  RATE_LIMIT_WRITE_PER_MIN: '20',
  RATE_LIMIT_TIGHTER_PER_MIN: '10',
  DATABASE_URL: 'REDACTED',
};

vi.mock('@/lib/env', () => ({
  env: {
    RATE_LIMIT_ENABLED: ENV.RATE_LIMIT_ENABLED,
    RATE_LIMIT_READ_PER_MIN: 60,
    RATE_LIMIT_WRITE_PER_MIN: 20,
    RATE_LIMIT_TIGHTER_PER_MIN: 10,
  },
}));

import {
  checkAndIncrement,
  deriveBucketKey,
  deriveCategory,
  resetRateLimitStateForTest,
  withRateLimit,
} from '@/lib/rate-limit';

beforeEach(() => {
  vi.resetModules();
  ENV.RATE_LIMIT_ENABLED = 'true';
  upsert.mockReset();
  deleteMany.mockReset();
  deleteMany.mockResolvedValue({ count: 0 });
  resetRateLimitStateForTest();
});

afterEach(() => {
  resetRateLimitStateForTest();
});

// ─────────────────────────── deriveBucketKey ──────────────────────────────

describe('deriveBucketKey', () => {
  it('returns a 64-char hex SHA-256 digest', async () => {
    const req = new Request('http://test/x', { headers: { 'x-api-key': 'k1' } });
    const k = deriveBucketKey(req);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different api-key values produce different keys', () => {
    const a = deriveBucketKey(new Request('http://test/x', { headers: { 'x-api-key': 'aaa' } }));
    const b = deriveBucketKey(new Request('http://test/x', { headers: { 'x-api-key': 'bbb' } }));
    expect(a).not.toBe(b);
  });

  it('same api-key produces same key', () => {
    const a = deriveBucketKey(new Request('http://test/x', { headers: { 'x-api-key': 'same' } }));
    const b = deriveBucketKey(new Request('http://test/x', { headers: { 'x-api-key': 'same' } }));
    expect(a).toBe(b);
  });

  it('falls back to session cookie when no api-key', () => {
    const req = new Request('http://test/x', {
      headers: { cookie: 'better-auth.session_token=abc123; foo=bar' },
    });
    const k = deriveBucketKey(req);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    const diff = deriveBucketKey(
      new Request('http://test/x', { headers: { cookie: 'better-auth.session_token=xyz' } }),
    );
    expect(k).not.toBe(diff);
  });

  it('falls back to x-forwarded-for when no credential', () => {
    const req = new Request('http://test/x', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    });
    const k = deriveBucketKey(req);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    const same = deriveBucketKey(
      new Request('http://test/x', { headers: { 'x-forwarded-for': '203.0.113.7' } }),
    );
    expect(k).toBe(same);
    const diff = deriveBucketKey(
      new Request('http://test/x', { headers: { 'x-forwarded-for': '198.51.100.1' } }),
    );
    expect(k).not.toBe(diff);
  });

  it('api-key header takes precedence over session cookie', () => {
    const a = deriveBucketKey(
      new Request('http://test/x', {
        headers: { 'x-api-key': 'k1', cookie: 'better-auth.session_token=s1' },
      }),
    );
    const b = deriveBucketKey(new Request('http://test/x', { headers: { 'x-api-key': 'k1' } }));
    expect(a).toBe(b);
  });
});

// ─────────────────────────── deriveCategory ───────────────────────────────

describe('deriveCategory', () => {
  it('GET → read', () => {
    expect(deriveCategory(new Request('http://test/api/v1/scans', { method: 'GET' }))).toBe('read');
  });
  it('HEAD → read', () => {
    expect(deriveCategory(new Request('http://test/api/v1/scans', { method: 'HEAD' }))).toBe(
      'read',
    );
  });
  it('OPTIONS → read', () => {
    expect(deriveCategory(new Request('http://test/api/v1/scans', { method: 'OPTIONS' }))).toBe(
      'read',
    );
  });

  it('POST /api/v1/scans → write', () => {
    expect(deriveCategory(new Request('http://test/api/v1/scans', { method: 'POST' }))).toBe(
      'write',
    );
  });
  it('POST /api/v1/aws/discover → write', () => {
    expect(deriveCategory(new Request('http://test/api/v1/aws/discover', { method: 'POST' }))).toBe(
      'write',
    );
  });
  it('POST /api/v1/azure/discover → write', () => {
    expect(
      deriveCategory(new Request('http://test/api/v1/azure/discover', { method: 'POST' })),
    ).toBe('write');
  });
  it('POST /api/v1/gcp/discover → write', () => {
    expect(deriveCategory(new Request('http://test/api/v1/gcp/discover', { method: 'POST' }))).toBe(
      'write',
    );
  });

  it('POST /api/v1/keys → tighter', () => {
    expect(deriveCategory(new Request('http://test/api/v1/keys', { method: 'POST' }))).toBe(
      'tighter',
    );
  });
  it('POST /api/v1/webhooks → tighter', () => {
    expect(deriveCategory(new Request('http://test/api/v1/webhooks', { method: 'POST' }))).toBe(
      'tighter',
    );
  });
  it('DELETE /api/v1/keys/abc → tighter', () => {
    expect(deriveCategory(new Request('http://test/api/v1/keys/abc', { method: 'DELETE' }))).toBe(
      'tighter',
    );
  });
  it('DELETE /api/v1/webhooks/abc → write (not tighter)', () => {
    expect(
      deriveCategory(new Request('http://test/api/v1/webhooks/abc', { method: 'DELETE' })),
    ).toBe('write');
  });
});

// ─────────────────────────── checkAndIncrement ─────────────────────────────

describe('checkAndIncrement', () => {
  it('returns allowed=true on first call', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 1 });
    const r = await checkAndIncrement('key1', 60);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.limit).toBe(60);
    expect(typeof r.resetAt).toBe('number');
  });

  it('increments count on subsequent calls within same window', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 2 });
    const r = await checkAndIncrement('key2', 60);
    expect(r.count).toBe(2);
  });

  it('returns allowed=false when count exceeds limit', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 61 });
    const r = await checkAndIncrement('key3', 60);
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(61);
  });

  it('falls back to a fresh upsert when DB row has stale windowStart', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute - 5, count: 5 });
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 1 });
    const r = await checkAndIncrement('key4', 60);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(r.count).toBe(1);
    expect(r.allowed).toBe(true);
  });

  it('returns allowed=true on DB error (fail-open)', async () => {
    upsert.mockRejectedValueOnce(new Error('db down'));
    const r = await checkAndIncrement('key5', 60);
    expect(r.allowed).toBe(true);
  });
});

// ─────────────────────────── withRateLimit ─────────────────────────────────

describe('withRateLimit', () => {
  it('attaches RateLimit-* headers to inner response', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 1 });
    const req = new Request('http://test/api/v1/scans', {
      method: 'GET',
      headers: { 'x-api-key': 'kk' },
    });
    const inner = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await withRateLimit(req, async () => inner);
    expect(out.status).toBe(200);
    expect(out.headers.get('RateLimit-Limit')).toBe('60');
    expect(out.headers.get('RateLimit-Remaining')).toBe('59');
    expect(out.headers.get('RateLimit-Reset')).toMatch(/^\d+$/);
  });

  it('returns 429 with retry-after when limit exceeded', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 100 });
    const req = new Request('http://test/api/v1/keys', {
      method: 'POST',
      headers: { 'x-api-key': 'kk' },
    });
    const inner = new Response('{}', { status: 200 });
    const out = await withRateLimit(req, async () => inner);
    expect(out.status).toBe(429);
    expect(out.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(out.headers.get('RateLimit-Remaining')).toBe('0');
    const body = await out.json();
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retryAfter).toBe('number');
  });

  it('attaches headers even when inner handler returns 401', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 1 });
    const req = new Request('http://test/api/v1/scans', {
      method: 'GET',
      headers: { 'x-api-key': 'kk' },
    });
    const inner = new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const out = await withRateLimit(req, async () => inner);
    expect(out.status).toBe(401);
    expect(out.headers.get('RateLimit-Limit')).toBe('60');
    expect(out.headers.get('RateLimit-Remaining')).toBe('59');
  });

  it('RATE_LIMIT_ENABLED=false bypasses bucket upsert but still attaches headers', async () => {
    ENV.RATE_LIMIT_ENABLED = 'false';
    vi.resetModules();
    const req = new Request('http://test/api/v1/scans', {
      method: 'GET',
      headers: { 'x-api-key': 'kk' },
    });
    const { withRateLimit: w } = await import('@/lib/rate-limit');
    const inner = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const out = await w(req, async () => inner);
    expect(out.status).toBe(200);
    expect(out.headers.get('RateLimit-Limit')).toBe('0');
    expect(out.headers.get('RateLimit-Remaining')).toBe('0');
    expect(upsert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── resetRateLimitStateForTest ────────────────────

describe('resetRateLimitStateForTest', () => {
  it('clears cached state so tests do not bleed', async () => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 1 });
    await checkAndIncrement('cachekey', 60);
    resetRateLimitStateForTest();
    // After reset, a fresh checkAndIncrement should reach the DB again.
    upsert.mockResolvedValueOnce({ windowStart: currentMinute, count: 1 });
    const r = await checkAndIncrement('cachekey', 60);
    expect(r.count).toBe(1);
  });
});
