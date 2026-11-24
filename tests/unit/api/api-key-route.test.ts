// @vitest-environment node
// Unit tests for /api/v1/keys**. Mocks @/lib/require-auth and
// @/lib/business/api-keys so we can pin down the handler gating without
// booting prisma / better-auth / scrypt.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// The handler imports prisma to look up the system team; stub that too.
const teamUpsert = vi.fn();
const teamFindUnique = vi.fn();
const apiKeyFindMany = vi.fn();
const apiKeyFindFirst = vi.fn();
const apiKeyCreate = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    team: {
      upsert: teamUpsert,
      findUnique: teamFindUnique,
      findUniqueOrThrow: teamFindUnique,
    },
    apiKey: {
      findMany: apiKeyFindMany,
      findFirst: apiKeyFindFirst,
      create: apiKeyCreate,
    },
  },
}));

// Mock the auth gate to return a known SessionUser shape.
const SESSION_USER = {
  id: 'user-admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
  emailVerified: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => SESSION_USER,
}));

// Mock createApiKey so the route doesn't actually hash/run crypto.
const createApiKeyMock = vi.fn();
vi.mock('@/lib/business/api-keys', () => ({
  createApiKey: (...args: unknown[]) => createApiKeyMock(...args),
  revokeApiKey: async (id: string, teamId: string) => {
    if (revokeApiKeyMock.shouldFail) return null;
    const row = revokeApiKeyMock.row ?? {
      id,
      teamId,
      revokedAt: new Date(),
    };
    return row;
  },
}));
const revokeApiKeyMock = {
  row: null as null | { id: string; teamId: string; revokedAt: Date },
  shouldFail: false,
};

function authedRequest(method: 'GET' | 'POST' | 'DELETE', path = '/api/v1/keys', body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://test${path}`, init);
}

function team_row() {
  return { id: 'team-system-id', name: 'system' };
}

beforeEach(() => {
  vi.resetModules();
  teamUpsert.mockReset();
  teamFindUnique.mockReset();
  apiKeyFindMany.mockReset();
  apiKeyFindFirst.mockReset();
  apiKeyCreate.mockReset();
  createApiKeyMock.mockReset();
  revokeApiKeyMock.row = null;
  revokeApiKeyMock.shouldFail = false;
  teamUpsert.mockResolvedValue(team_row());
  teamFindUnique.mockResolvedValue(team_row());
});

// ===================== GET /api/v1/keys =====================

describe('GET /api/v1/keys', () => {
  it('lists keys for the resolved teamId', async () => {
    apiKeyFindMany.mockResolvedValueOnce([
      {
        id: 'key-1',
        name: 'prod-ci',
        hash: 'placeholder',
        teamId: 'team-system-id',
        scopeKind: 'team',
        scanId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
        team: { id: 'team-system-id', name: 'system' },
      },
    ]);
    const { GET } = await import('@/app/api/v1/keys/route');
    const res = await GET(authedRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('key-1');
    expect(body.items[0].name).toBe('prod-ci');
    expect(body.items[0].scopeKind).toBe('team');
    expect(body.items[0].team.name).toBe('system');
    expect(body.items[0].revokedAt).toBeNull();
    expect(apiKeyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 'team-system-id' } }),
    );
  });

  it('returns 500 when prisma throws', async () => {
    apiKeyFindMany.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/v1/keys/route');
    const res = await GET(authedRequest('GET'));
    expect(res.status).toBe(500);
  });
});

// ===================== POST /api/v1/keys =====================

describe('POST /api/v1/keys', () => {
  it('creates a team-scope key and returns the plaintext secret once', async () => {
    createApiKeyMock.mockResolvedValueOnce({
      record: {
        id: 'key-new',
        name: 'prod',
        hash: 'placeholder',
        teamId: 'team-system-id',
        scopeKind: 'team',
        scanId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
      plaintext: 'plain-secret-token',
    });
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/keys', { name: 'prod', scopeKind: 'team' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('key-new');
    expect(body.name).toBe('prod');
    expect(body.scopeKind).toBe('team');
    expect(body.team.name).toBe('system');
    expect(body.secret).toBe('plain-secret-token');
  });

  it('creats a scan-scope key when scanId is provided', async () => {
    createApiKeyMock.mockResolvedValueOnce({
      record: {
        id: 'key-scan',
        name: 'single',
        hash: 'placeholder',
        teamId: 'team-system-id',
        scopeKind: 'scan',
        scanId: 'scan-x',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
      plaintext: 'scan-secret',
    });
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/keys', {
        name: 'single',
        scopeKind: 'scan',
        scanId: 'scan-x',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scopeKind).toBe('scan');
    expect(body.scanId).toBe('scan-x');
  });

  it('returns 400 when scopeKind=scan without scanId', async () => {
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(authedRequest('POST', '/api/v1/keys', { name: 'x', scopeKind: 'scan' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors?.scanId ?? body.scanId).toBeTruthy();
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when scopeKind=team with a stray scanId', async () => {
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/keys', {
        name: 'x',
        scopeKind: 'team',
        scanId: 'scan-x',
      }),
    );
    expect(res.status).toBe(400);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is malformed JSON', async () => {
    // Ban raw invalid body shapes — { scopeKind: 'team' } without a name.
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(
      new Request('http://test/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeKind: 'team' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is too long', async () => {
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(
      authedRequest('POST', '/api/v1/keys', {
        name: 'x'.repeat(120),
        scopeKind: 'team',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON', async () => {
    const { POST } = await import('@/app/api/v1/keys/route');
    const res = await POST(
      new Request('http://test/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ===================== DELETE /api/v1/keys/[id] =====================

describe('DELETE /api/v1/keys/[id]', () => {
  it('soft-revokes an active key with 204', async () => {
    apiKeyFindFirst.mockResolvedValueOnce({
      id: 'key-1',
      teamId: 'team-system-id',
      scopeKind: 'team',
      scanId: null,
      hash: 'placeholder',
      name: 'prod',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUsedAt: null,
      revokedAt: null,
    });
    revokeApiKeyMock.row = {
      id: 'key-1',
      teamId: 'team-system-id',
      revokedAt: new Date(),
    };
    const { DELETE } = await import('@/app/api/v1/keys/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/keys/key-1'), {
      params: Promise.resolve({ id: 'key-1' }),
    });
    expect(res.status).toBe(204);
  });

  it('returns 404 for foreign-team rows (never reveal existence)', async () => {
    apiKeyFindFirst.mockResolvedValueOnce(null);
    const { DELETE } = await import('@/app/api/v1/keys/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/keys/foreign'), {
      params: Promise.resolve({ id: 'foreign' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });

  it('returns 409 when the key is already revoked', async () => {
    apiKeyFindFirst.mockResolvedValueOnce({
      id: 'key-1',
      teamId: 'team-system-id',
      scopeKind: 'team',
      scanId: null,
      hash: 'placeholder',
      name: 'prod',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUsedAt: null,
      revokedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const { DELETE } = await import('@/app/api/v1/keys/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/keys/key-1'), {
      params: Promise.resolve({ id: 'key-1' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already_revoked');
  });

  it('returns 400 on a malformed id', async () => {
    const { DELETE } = await import('@/app/api/v1/keys/[id]/route');
    const res = await DELETE(authedRequest('DELETE', '/api/v1/keys/has%20space'), {
      params: Promise.resolve({ id: 'has space' }),
    });
    expect(res.status).toBe(400);
  });
});

// ===================== ADMIN GATING =====================

describe('GET /api/v1/keys admin gate', () => {
  it('returns 403 for non-admin session users', async () => {
    vi.doMock('@/lib/require-auth', () => ({
      requireAuth: async () => ({ ...SESSION_USER, role: 'user' }),
    }));
    const { GET } = await import('@/app/api/v1/keys/route');
    const res = await GET(authedRequest('GET'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(apiKeyFindMany).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no session', async () => {
    vi.doMock('@/lib/require-auth', () => ({
      requireAuth: async () => {
        throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      },
    }));
    const { GET } = await import('@/app/api/v1/keys/route');
    const res = await GET(authedRequest('GET'));
    expect(res.status).toBe(401);
  });
});
