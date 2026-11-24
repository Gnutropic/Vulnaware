// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireMemberMock,
  alertFindFirstMock,
  cveEntryFindUniqueMock,
  fixFindFirstMock,
  fixUpsertMock,
  chatMock,
  setRequestAuthMock,
} = vi.hoisted(() => ({
  requireMemberMock: vi.fn(),
  alertFindFirstMock: vi.fn(),
  cveEntryFindUniqueMock: vi.fn(),
  fixFindFirstMock: vi.fn(),
  fixUpsertMock: vi.fn(),
  chatMock: vi.fn(),
  setRequestAuthMock: vi.fn(),
}));

const envValues: Record<string, string | undefined> = {
  POLSIA_API_KEY: 'test-key',
  POLSIA_API_TOKEN: undefined,
};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/alert-workspace-access', () => ({
  requireAlertWorkspaceMember: requireMemberMock,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    alert: { findFirst: alertFindFirstMock },
    cveEntry: { findUnique: cveEntryFindUniqueMock },
    alertCveFix: { findFirst: fixFindFirstMock, upsert: fixUpsertMock },
  },
}));
vi.mock('@/lib/env', () => ({
  env: new Proxy({}, { get: (_target, property: string) => envValues[property] }),
}));
vi.mock('@/lib/ai/client', () => ({
  AiConfigurationError: class AiConfigurationError extends Error {},
  chat: chatMock,
}));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: setRequestAuthMock,
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

const memberContext = {
  user: { id: 'user-1' },
  workspaceId: 'workspace-1',
  workspaceMemberId: 'member-1',
};

function request(id = 'alert-1', method = 'POST') {
  return new Request(`http://test/api/alerts/${id}/suggested-fix`, { method });
}

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    severity: 'high',
    source: 'kev',
    finding: {
      cveId: 'CVE-2025-0001',
      asset: { host: 'edge.example.com', ip: '203.0.113.10', port: 443, protocol: 'tcp' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  envValues.POLSIA_API_KEY = 'test-key';
  envValues.POLSIA_API_TOKEN = undefined;
  requireMemberMock.mockResolvedValue(memberContext);
  alertFindFirstMock.mockResolvedValue(alertRow());
  cveEntryFindUniqueMock.mockResolvedValue({
    cvssScore: 8.1,
    description: 'A vulnerability in the exposed service allows unauthorized access.',
  });
  fixFindFirstMock.mockResolvedValue(null);
  fixUpsertMock.mockResolvedValue(undefined);
});

describe('POST /api/alerts/[id]/suggested-fix', () => {
  it('preserves the workspace-member gate before any alert or AI work', async () => {
    requireMemberMock.mockRejectedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const { POST } = await import('@/app/api/alerts/[id]/suggested-fix/route');

    const response = await POST(request(), { params: Promise.resolve({ id: 'alert-1' }) });

    expect(response.status).toBe(401);
    expect(alertFindFirstMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('returns an opaque scoped 404 without calling AI', async () => {
    alertFindFirstMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/suggested-fix/route');

    const response = await POST(request(), { params: Promise.resolve({ id: 'foreign-alert' }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('returns insufficient context without spending AI tokens', async () => {
    alertFindFirstMock.mockResolvedValueOnce(alertRow({ finding: { cveId: 'UNKNOWN', asset: null } }));
    cveEntryFindUniqueMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/suggested-fix/route');

    const response = await POST(request(), { params: Promise.resolve({ id: 'alert-1' }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      error: 'insufficient_context',
      missing: ['cve', 'description'],
    });
    expect(chatMock).not.toHaveBeenCalled();
    expect(fixUpsertMock).not.toHaveBeenCalled();
  });

  it('grounds generated advice in alert details and writes the new cache version', async () => {
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        steps: [
          { title: 'Review the affected service', body: 'Confirm the service on edge.example.com.' },
          { title: 'Apply available remediation', body: 'Use the remediation documented for CVE-2025-0001.' },
        ],
      }),
    );
    const { POST } = await import('@/app/api/alerts/[id]/suggested-fix/route');

    const response = await POST(request(), { params: Promise.resolve({ id: 'alert-1' }) });
    const body = await response.json();
    const call = chatMock.mock.calls[0]?.[0];

    expect(response.status).toBe(200);
    expect(body.steps).toHaveLength(2);
    expect(call.task).toBe('cve-remediation-guidance');
    expect(call.messages[1].content).toContain('CVE-2025-0001');
    expect(call.messages[1].content).toContain('edge.example.com');
    expect(call.messages[1].content).not.toContain('Recent notes');
    expect(call.messages[1].content).not.toContain('recommendedFix');
    expect(fixUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ promptVersion: 'v2-alert-context-only' }),
        update: expect.objectContaining({ promptVersion: 'v2-alert-context-only' }),
      }),
    );
  });

  it('treats invalid model output and missing AI configuration as unavailable', async () => {
    chatMock.mockResolvedValueOnce('not json');
    const { POST } = await import('@/app/api/alerts/[id]/suggested-fix/route');

    const invalidResponse = await POST(request(), { params: Promise.resolve({ id: 'alert-1' }) });
    expect(invalidResponse.status).toBe(503);
    expect(fixUpsertMock).not.toHaveBeenCalled();

    envValues.POLSIA_API_KEY = undefined;
    envValues.POLSIA_API_TOKEN = undefined;
    const unavailableResponse = await POST(request(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(unavailableResponse.status).toBe(503);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/alerts/[id]/suggested-fix', () => {
  it('does not display an old seed-based cache row', async () => {
    fixFindFirstMock.mockResolvedValueOnce({
      fixStepsJson: JSON.stringify([{ id: 'old', title: 'Old', body: 'Old advice' }]),
      model: 'gpt-4o-mini',
      generatedAt: new Date('2026-10-01T00:00:00.000Z'),
      promptVersion: 'v1',
    });
    const { GET } = await import('@/app/api/alerts/[id]/suggested-fix/route');

    const response = await GET(request('alert-1', 'GET'), { params: Promise.resolve({ id: 'alert-1' }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });
});
