// @vitest-environment node
// @polsia:user-owned — Authentication, validation, authorization, and cookie coverage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/workspace/active/route';

const { requireAuthMock, resolveActiveWorkspaceIdMock, canAccessWorkspaceMock } = vi.hoisted(
  () => ({
    requireAuthMock: vi.fn(),
    resolveActiveWorkspaceIdMock: vi.fn(),
    canAccessWorkspaceMock: vi.fn(),
  }),
);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/lib/business/active-workspace', () => ({
  ACTIVE_WORKSPACE_COOKIE: 'polsia_active_workspace',
  ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
  canAccessWorkspace: canAccessWorkspaceMock,
  resolveActiveWorkspaceId: resolveActiveWorkspaceIdMock,
}));

const user = { id: 'user-1' };

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/workspace/active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/workspace/active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockResolvedValue(user);
    resolveActiveWorkspaceIdMock.mockResolvedValue('workspace-1');
    canAccessWorkspaceMock.mockResolvedValue(true);
  });

  it('returns 401 for unauthenticated GET and POST requests', async () => {
    requireAuthMock.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const getResponse = await GET(new Request('http://localhost/api/workspace/active'));
    const postResponse = await POST(jsonRequest({ workspaceId: 'workspace-1' }));

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(resolveActiveWorkspaceIdMock).not.toHaveBeenCalled();
    expect(canAccessWorkspaceMock).not.toHaveBeenCalled();
  });

  it('returns the validated workspace from the shared resolver', async () => {
    const response = await GET(new Request('http://localhost/api/workspace/active'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ workspaceId: 'workspace-1' });
    expect(resolveActiveWorkspaceIdMock).toHaveBeenCalledWith(user.id);
  });

  it('returns 404 when no owned fallback workspace exists', async () => {
    resolveActiveWorkspaceIdMock.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/workspace/active'));

    expect(response.status).toBe(404);
    expect(resolveActiveWorkspaceIdMock).toHaveBeenCalledWith(user.id);
  });

  it('returns 400 for invalid JSON shape without setting a cookie', async () => {
    const response = await POST(jsonRequest({ workspaceId: '' }));

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(canAccessWorkspaceMock).not.toHaveBeenCalled();
  });

  it('returns 403 and leaves the cookie unchanged for inaccessible workspaces', async () => {
    canAccessWorkspaceMock.mockResolvedValue(false);

    const response = await POST(jsonRequest({ workspaceId: 'other-workspace' }));

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(canAccessWorkspaceMock).toHaveBeenCalledWith(user.id, 'other-workspace');
  });

  it.each(['owned', 'active member'])('sets a protected cookie for an accessible %s workspace', async () => {
    const response = await POST(jsonRequest({ workspaceId: 'workspace-2' }));
    const setCookie = response.headers.get('set-cookie');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ workspaceId: 'workspace-2' });
    expect(setCookie).toContain('polsia_active_workspace=workspace-2');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).toMatch(/Max-Age=2592000/i);
    expect(canAccessWorkspaceMock).toHaveBeenCalledWith(user.id, 'workspace-2');
  });
});
