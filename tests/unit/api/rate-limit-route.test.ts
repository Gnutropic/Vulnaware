// @vitest-environment node
// Route integration tests for withRateLimit on a representative handler.
// Imports GET from src/app/api/v1/scans/route.ts. Mocks Prisma, server-only,
// api-auth, and rate-limit to test the end-to-end wrapping behaviour.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// ── Mock Prisma ───────────────────────────────────────────────────────────────

const upsert = vi.fn();
const deleteMany = vi.fn();
const scanFindMany = vi.fn();
const scanCount = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    rateLimitBucket: { upsert, deleteMany },
    scan: { findMany: scanFindMany, count: scanCount },
  },
}));

// ── Mock env ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: {
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_READ_PER_MIN: 60,
    RATE_LIMIT_WRITE_PER_MIN: 20,
    RATE_LIMIT_TIGHTER_PER_MIN: 10,
  },
}));

// ── Mock api-auth ─────────────────────────────────────────────────────────────

vi.mock('@/lib/api-auth', () => ({
  verifyApiKey: async (req: Request) => {
    const key = req.headers.get('x-api-key');
    if (!key) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return {
      ok: true as const,
      teamId: 'team-t',
      scopeKind: 'team' as const,
      scanId: null,
      keyId: 'k1',
    };
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGet(key: string | null) {
  const h: Record<string, string> = {};
  if (key !== null) h['x-api-key'] = key;
  return new Request('http://test/api/v1/scans', { method: 'GET', headers: h });
}

function currentMinute() {
  return Math.floor(Date.now() / 60_000);
}

beforeEach(async () => {
  vi.resetModules();
  upsert.mockReset();
  deleteMany.mockReset();
  scanFindMany.mockReset();
  scanCount.mockReset();
  deleteMany.mockResolvedValue({ count: 0 });
  // Reset in-process cache between tests
  const { resetRateLimitStateForTest } = await import('@/lib/rate-limit');
  resetRateLimitStateForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Headers on success (200)', () => {
  it('attaches RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset on a 200 response', async () => {
    const cm = currentMinute();
    upsert.mockResolvedValueOnce({ windowStart: cm, count: 5 });
    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(makeGet('valid-key'));
    expect(res.status).toBe(200);
    expect(res.headers.get('RateLimit-Limit')).toBe('60');
    expect(res.headers.get('RateLimit-Remaining')).toBe('55');
    expect(res.headers.get('RateLimit-Reset')).toMatch(/^\d+$/);
  });
});

describe('429 on exceeded limit', () => {
  it('returns 429 JSON body and Retry-After when limit exceeded', async () => {
    const cm = currentMinute();
    upsert.mockResolvedValueOnce({ windowStart: cm, count: 61 });

    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(makeGet('valid-key'));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retryAfter).toBe('number');
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(res.headers.get('RateLimit-Remaining')).toBe('0');
    // Inner handler should NOT have been called — Prisma scan calls are zero.
    expect(scanFindMany).not.toHaveBeenCalled();
  });
});

describe('Headers on auth error (401)', () => {
  it('still carries RateLimit-* headers on a 401 response', async () => {
    const cm = currentMinute();
    upsert.mockResolvedValueOnce({ windowStart: cm, count: 1 });

    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(makeGet(null)); // no API key → 401
    expect(res.status).toBe(401);
    // withRateLimit wraps outside withApiRequest so it still increments and
    // attaches headers even on 401.
    expect(res.headers.get('RateLimit-Limit')).toBe('60');
    expect(res.headers.get('RateLimit-Remaining')).toBe('59');
  });
});

describe('RATE_LIMIT_ENABLED=false', () => {
  it('passes the request through without a Prisma upsert', async () => {
    vi.doMock('@/lib/env', () => ({
      env: {
        RATE_LIMIT_ENABLED: 'false',
        RATE_LIMIT_READ_PER_MIN: 60,
        RATE_LIMIT_WRITE_PER_MIN: 20,
        RATE_LIMIT_TIGHTER_PER_MIN: 10,
      },
    }));

    // Reset modules so the new env mock is picked up.
    vi.resetModules();
    const { resetRateLimitStateForTest } = await import('@/lib/rate-limit');
    resetRateLimitStateForTest();

    scanFindMany.mockResolvedValueOnce([]);
    scanCount.mockResolvedValueOnce(0);

    const { GET } = await import('@/app/api/v1/scans/route');
    const res = await GET(makeGet('valid-key'));
    expect(res.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    // Headers are still present with zero values
    expect(res.headers.get('RateLimit-Limit')).toBe('0');
    expect(res.headers.get('RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('RateLimit-Reset')).toBe('0');
  });
});
