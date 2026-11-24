// @vitest-environment node
// Unit tests for GET /api/v1/webhooks/triggers. Pins:
//   - 401 anon, 403 non-admin, 200 admin auth gates.
//   - team scoping (where.teamId).
//   - ordering (orderBy: receivedAt desc) and take: 20.
//   - explicit select whitelist (no include, no nested webhook relation
//     that would expose signingSecretCipher).
//   - redaction: response body never contains 'signingSecretCipher',
//     'secret', 'signatureHeader', 'X-Webhook-Signature', 'X-VulnAware-Signature',
//     nor any literal leak string from a deliberately-leaky mock row.
//   - 500 envelope on prisma throw.
//   - 405 with Allow: GET for non-GET verbs.
//
// Mirrors the harness at tests/unit/api/api-key-route.test.ts and
// tests/unit/api/webhooks-trigger-route.test.ts.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// withRateLimit (transitively imported by the route) reads env; stub it
// to the documented per-min block to keep the limiter out of the unit path.
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_READ_PER_MIN: 60,
    RATE_LIMIT_WRITE_PER_MIN: 20,
    RATE_LIMIT_TIGHTER_PER_MIN: 10,
  },
}));

// Only the model surfaces the route actually touches: team.upsert for the
// resolved teamId, webhookTrigger.findMany for the listing. Pin nothing
// else; if a future change introduces another model the test fails loudly.
const teamUpsert = vi.fn();
const teamFindUnique = vi.fn();
const webhookTriggerFindMany = vi.fn();
const rateLimitUpsert = vi.fn();
const rateLimitDeleteMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    team: {
      upsert: teamUpsert,
      findUnique: teamFindUnique,
      findUniqueOrThrow: teamFindUnique,
    },
    webhookTrigger: {
      findMany: webhookTriggerFindMany,
    },
    rateLimitBucket: {
      upsert: rateLimitUpsert,
      deleteMany: rateLimitDeleteMany,
    },
  },
}));

const requireAuthSpy = vi.fn();

vi.mock('@/lib/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthSpy(...args),
}));

const SESSION_USER = {
  id: 'user-admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
  emailVerified: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const USER_SESSION = {
  ...SESSION_USER,
  role: 'user' as const,
};

function makeRequest(): Request {
  return new Request('http://test/api/v1/webhooks/triggers', {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
}

function seedTriggerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trigger-1',
    scanId: 'scan-1',
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    repositoryUrl: 'https://github.com/acme/api',
    repositoryRef: 'refs/heads/main',
    repositoryCommit: 'abc1234',
    buildId: 'build-1',
    buildStatus: 'success',
    buildBranch: 'main',
    signatureAlgorithm: 'hmac-sha256',
    scan: { id: 'scan-1', status: 'completed' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  requireAuthSpy.mockReset();
  teamUpsert.mockReset();
  teamFindUnique.mockReset();
  webhookTriggerFindMany.mockReset();
  rateLimitUpsert.mockReset();
  rateLimitDeleteMany.mockReset();
  // Default rate limiter behavior: allow + count 1.
  rateLimitUpsert.mockResolvedValue({ windowStart: Math.floor(Date.now() / 60_000), count: 1 });
  rateLimitDeleteMany.mockResolvedValue({ count: 0 });
  teamUpsert.mockResolvedValue({ id: 'team-system-id', name: 'system' });
  teamFindUnique.mockResolvedValue({ id: 'team-system-id', name: 'system' });
  webhookTriggerFindMany.mockResolvedValue([]);
  // Default: admin session so tests without session-gating overrides pass.
  requireAuthSpy.mockResolvedValue(SESSION_USER);
});

// ===================== AUTH GATES =====================

describe('GET /api/v1/webhooks/triggers auth gates', () => {
  it('returns 401 when there is no session', async () => {
    requireAuthSpy.mockImplementationOnce(async () => {
      throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    // The thrown Response should NOT trigger the prisma.webhookTrigger
    // lookup — anon callers see 401 without DB touch.
    expect(webhookTriggerFindMany).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin sessions (and no DB call)', async () => {
    requireAuthSpy.mockResolvedValueOnce(USER_SESSION);
    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(webhookTriggerFindMany).not.toHaveBeenCalled();
  });

  it('lists triggers for an admin session (200 with <= 20 items)', async () => {
    // Seed 25 rows; assert the route caps at 20 via prisma's `take: 20`
    // AND the parsed body has exactly the rows Prisma returned.
    const many = Array.from({ length: 25 }, (_, i) => seedTriggerRow({ id: `trigger-${i + 1}` }));
    webhookTriggerFindMany.mockResolvedValueOnce(many.slice(0, 20));
    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(20);

    // Reach the audit gating call — pin take + orderBy + where + absence
    // of `include`.
    expect(webhookTriggerFindMany).toHaveBeenCalledTimes(1);
    const callArgs = webhookTriggerFindMany.mock.calls[0]?.[0] as {
      where?: { teamId?: string };
      orderBy?: { receivedAt?: string };
      take?: number;
      select?: Record<string, unknown>;
      include?: unknown;
    };
    expect(callArgs.where).toMatchObject({ teamId: 'team-system-id' });
    expect(callArgs.orderBy).toEqual({ receivedAt: 'desc' });
    expect(callArgs.take).toBe(20);
    expect(callArgs.include).toBeUndefined();
    expect(callArgs.select).toBeDefined();
  });
});

// ===================== FIELD WHITELIST + REDACTION =====================

describe('GET /api/v1/webhooks/triggers redaction', () => {
  it('returns ONLY the whitelisted keys per item (no signing material)', async () => {
    // Deliberately-leaky row: includes a hypothetical `signingSecretCipher`
    // and `secret` field (e.g. if a future someone accidentally selects the
    // related Webhook row or forgets to whitelist). The route MUST drop
    // both via the explicit `.select()` AND the `toItem()` projection AND
    // the `.strict()` zod parse.
    const leaky = seedTriggerRow({
      webhook: {
        id: 'wh-1',
        url: 'https://hooks.example.com/1',
        signingSecretCipher: 'enc:v1:plain-leak:ciphertag',
        signingAlgorithm: 'hmac-sha256',
      },
      secret: 'plain-leak',
    });
    webhookTriggerFindMany.mockResolvedValueOnce([leaky]);

    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.items).toHaveLength(1);

    const expectedKeys = [
      'id',
      'scanId',
      'receivedAt',
      'repositoryUrl',
      'repositoryRef',
      'repositoryCommit',
      'buildId',
      'buildStatus',
      'buildBranch',
      'signatureAlgorithm',
      'status',
    ].sort();
    const actualKeys = Object.keys(body.items[0]).sort();
    expect(actualKeys).toEqual(expectedKeys);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('signingSecretCipher');
    expect(serialized).not.toContain('"secret"');
    expect(serialized).not.toContain('signatureHeader');
    expect(serialized).not.toContain('X-Webhook-Signature');
    expect(serialized).not.toContain('X-VulnAware-Signature');
    expect(serialized).not.toContain('enc:v1:plain-leak:ciphertag');
    expect(serialized).not.toContain('plain-leak');
  });

  it('passes `teamId` from getOrCreateTeamForUser (resolved team), not the foreign team', async () => {
    // Foreign-team safeguard: even if a foreign team id is somehow supplied
    // to the request, the route only queries by the resolved teamId from
    // getOrCreateTeamForUser. teamId here is the canonical "system" upsert
    // result — the route never reads it from anywhere else.
    teamUpsert.mockResolvedValueOnce({ id: 'team-system-id', name: 'system' });
    webhookTriggerFindMany.mockResolvedValueOnce([]);

    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    await GET(makeRequest());

    expect(webhookTriggerFindMany).toHaveBeenCalledTimes(1);
    const callArgs = webhookTriggerFindMany.mock.calls[0]?.[0] as {
      where?: { teamId?: string };
    };
    expect(callArgs.where).toMatchObject({ teamId: 'team-system-id' });
  });

  it('scopes prisma query by teamId — never an unscoped listing', async () => {
    webhookTriggerFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    await GET(makeRequest());
    const callArgs = webhookTriggerFindMany.mock.calls[0]?.[0] as {
      where?: unknown;
    };
    expect(callArgs.where).toBeDefined();
    expect((callArgs.where as { teamId?: string }).teamId).toBe('team-system-id');
  });
});

// ===================== TEAM RESOLUTION =====================

describe('GET /api/v1/webhooks/triggers team resolution', () => {
  it('upserts the "system" team for admins and resolves teamId from the upsert result', async () => {
    teamUpsert.mockResolvedValueOnce({ id: 'team-system-id', name: 'system' });
    webhookTriggerFindMany.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    await GET(makeRequest());

    expect(teamUpsert).toHaveBeenCalledWith({
      where: { name: 'system' },
      update: {},
      create: { name: 'system' },
    });
    const callArgs = webhookTriggerFindMany.mock.calls[0]?.[0] as {
      where?: { teamId?: string };
    };
    expect(callArgs.where?.teamId).toBe('team-system-id');
  });
});

// ===================== ERROR SURFACE =====================

describe('GET /api/v1/webhooks/triggers error surface', () => {
  it('returns 500 {error:"Internal Server Error"} when prisma.webhookTrigger throws', async () => {
    webhookTriggerFindMany.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/v1/webhooks/triggers/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal Server Error');
  });
});

// ===================== OTHER VERBS (405) =====================

describe('GET /api/v1/webhooks/triggers other verbs', () => {
  it.each<['POST' | 'PUT' | 'PATCH' | 'DELETE']>(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'returns 405 with Allow: GET for %s',
    async (method) => {
      const route = (await import('@/app/api/v1/webhooks/triggers/route')) as unknown as Record<
        string,
        () => Promise<Response>
      >;
      const handler = route[method];
      expect(typeof handler).toBe('function');
      const res = await (handler as () => Promise<Response>)();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
      const body = await res.json();
      expect(body.code).toBe('method_not_allowed');
    },
  );

  it('GET still returns 200 alongside the 405 handlers (no shadowing)', async () => {
    webhookTriggerFindMany.mockResolvedValueOnce([seedTriggerRow()]);
    const route = (await import('@/app/api/v1/webhooks/triggers/route')) as unknown as Record<
      string,
      (req: Request) => Promise<Response>
    >;
    expect(typeof route.GET).toBe('function');
    const res = await route.GET(makeRequest());
    expect(res.status).toBe(200);
  });
});
