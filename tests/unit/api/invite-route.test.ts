// @vitest-environment node
// Unit tests for the invite routes:
//   - POST /api/team/memberships/invite  (issuer)
//   - GET  /api/invites/[token]         (lookup)
//   - POST /api/invites/[token]/accept  (accept flow)
//
// Mocks the prisma invite surface + the prisma user/team/membership surface
// the accept route needs, the team-auth gate, the email transport +
// from-category helper, the audit + extractIp side-effects, the @/lib/env
// stub, the @/lib/auth better-auth surface (getSession/signInEmail/signUpEmail),
// and next/headers.
//
// We assert 401 / 403 / 400 / 201 / idempotent-refresh / 404 / 410 / 200
// branches without booting prisma / better-auth or hitting the email proxy.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// Stable top-level vi.fn() references that BOTH the @/lib/db mock factory
// AND the per-test suites share. The same `inviteFindFirst` is what the
// issuer test mocks AND what the route actually executes against.
const inviteFindFirst = vi.fn();
const inviteCreate = vi.fn();
const inviteUpdate = vi.fn();
const inviteDeleteMany = vi.fn();
const inviteDelete = vi.fn();
const userFindUnique = vi.fn();
const teamFindUnique = vi.fn();
const membershipFindUnique = vi.fn();
const membershipCreate = vi.fn();
const membershipDelete = vi.fn();
const membershipDeleteMany = vi.fn();
const workspaceMemberUpsert = vi.fn();
const workspaceMemberDeleteMany = vi.fn();
const workspaceMemberCount = vi.fn().mockResolvedValue(0);
const workspaceUpsert = vi.fn();
const workspaceDeleteMany = vi.fn();
const workspaceUpdateMany = vi.fn();
const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  // The route wraps (membership.create/deleteMany/invite.delete) inside
  // $transaction; pass a tx-shaped object whose methods forward to the
  // same spies so the assertions see them.
  const tx = {
    membership: {
      findUnique: membershipFindUnique,
      create: membershipCreate,
      delete: membershipDelete,
      deleteMany: membershipDeleteMany,
    },
    invite: { delete: inviteDelete },
    workspace: {
      upsert: workspaceUpsert,
      deleteMany: workspaceDeleteMany,
      updateMany: workspaceUpdateMany,
    },
    workspaceMember: {
      upsert: workspaceMemberUpsert,
      deleteMany: workspaceMemberDeleteMany,
      count: workspaceMemberCount,
    },
  };
  return fn(tx);
});

vi.mock('@/lib/db', () => ({
  prisma: {
    invite: {
      findFirst: inviteFindFirst,
      create: inviteCreate,
      update: inviteUpdate,
      deleteMany: inviteDeleteMany,
      delete: inviteDelete,
    },
    user: { findUnique: userFindUnique },
    team: { findUnique: teamFindUnique },
    membership: {
      findUnique: membershipFindUnique,
      create: membershipCreate,
      delete: membershipDelete,
      deleteMany: membershipDeleteMany,
    },
    $transaction: transaction,
  },
}));

const ADMIN_CTX = {
  user: {
    id: 'inviter-1',
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    emailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  membership: { id: 'mem-1', userId: 'inviter-1', teamId: 'team-1', role: 'admin' },
  team: { id: 'team-1', name: 'Acme Inc' },
};

let requireTeamRoleMock = vi.fn(async () => ADMIN_CTX);

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: async () => requireTeamRoleMock(),
}));

const fromForMock = vi.fn().mockReturnValue('team@vulnaware.com');
vi.mock('@/lib/email/from', () => ({
  fromFor: fromForMock,
}));

const sendEmailMock = vi.fn().mockResolvedValue({ id: 'msg-1' });
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (input: unknown) => sendEmailMock(input),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
const extractIpMock = vi.fn().mockReturnValue('203.0.113.7');
vi.mock('@/lib/business/audit', () => ({
  audit: async (...args: unknown[]) => auditMock(...args),
  extractIp: (...args: unknown[]) => extractIpMock(...args),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    EMAIL_FROM_INVITES: 'team@vulnaware.com',
    POLSIA_EMAIL_PROXY_URL: 'https://email.example.com/send',
  },
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-test': '1' }),
}));

const getSessionMock = vi.fn();
const signInEmailMock = vi.fn();
const signUpEmailMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: async (...args: unknown[]) => getSessionMock(...args),
      signInEmail: async (...args: unknown[]) => signInEmailMock(...args),
      signUpEmail: async (...args: unknown[]) => signUpEmailMock(...args),
    },
  },
}));

function jsonRequest(body: unknown) {
  return new Request('http://test/api/team/memberships/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resetAllPrisma() {
  inviteFindFirst.mockReset();
  inviteCreate.mockReset();
  inviteUpdate.mockReset();
  inviteDeleteMany.mockReset();
  inviteDelete.mockReset();
  userFindUnique.mockReset();
  teamFindUnique.mockReset();
  membershipFindUnique.mockReset();
  membershipCreate.mockReset();
  membershipDelete.mockReset();
  membershipDeleteMany.mockReset();
  workspaceMemberUpsert.mockReset();
  workspaceMemberDeleteMany.mockReset();
  workspaceMemberCount.mockReset().mockResolvedValue(0);
  workspaceUpsert.mockReset();
  workspaceDeleteMany.mockReset();
  workspaceUpdateMany.mockReset();
  transaction.mockReset();
  // Re-establish $transaction's default (invoke the callback with a tx shim
  // whose methods forward to the same spies).
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      membership: {
        findUnique: membershipFindUnique,
        create: membershipCreate,
        delete: membershipDelete,
        deleteMany: membershipDeleteMany,
      },
      invite: { delete: inviteDelete },
      workspace: {
        upsert: workspaceUpsert,
        deleteMany: workspaceDeleteMany,
        updateMany: workspaceUpdateMany,
      },
      workspaceMember: {
        upsert: workspaceMemberUpsert,
        deleteMany: workspaceMemberDeleteMany,
        count: workspaceMemberCount,
      },
    };
    return fn(tx);
  });
}

beforeEach(() => {
  vi.resetModules();
  resetAllPrisma();
  requireTeamRoleMock = vi.fn(async () => ADMIN_CTX);
  fromForMock.mockReset().mockReturnValue('team@vulnaware.com');
  sendEmailMock.mockReset().mockResolvedValue({ id: 'msg-1' });
  auditMock.mockReset().mockResolvedValue(undefined);
  extractIpMock.mockReset().mockReturnValue('203.0.113.7');
  getSessionMock.mockReset().mockResolvedValue(null);
  signInEmailMock.mockReset();
  signUpEmailMock.mockReset();
  // Default issuer-side: no prior pending row → handler goes down the create path.
  inviteFindFirst.mockResolvedValue(null);
  inviteDeleteMany.mockResolvedValue({ count: 0 });
  inviteCreate.mockResolvedValue({
    id: 'invite-new',
    createdAt: new Date('2026-07-23T10:00:00Z'),
  });
});

// ─────── Issuer: auth gates ──────────────────────────────────────────────

describe('POST /api/team/memberships/invite auth gate', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock = vi.fn(() => {
      throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { POST } = await import('@/app/api/team/memberships/invite/route');
    const res = await POST(jsonRequest({ email: 'i@x.com', ttlSeconds: 3600 }));
    expect(res.status).toBe(401);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(inviteFindFirst).not.toHaveBeenCalled();
    expect(inviteCreate).not.toHaveBeenCalled();
    expect(inviteUpdate).not.toHaveBeenCalled();
    expect(inviteDeleteMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is below admin role', async () => {
    requireTeamRoleMock = vi.fn(() => {
      throw new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { POST } = await import('@/app/api/team/memberships/invite/route');
    const res = await POST(jsonRequest({ email: 'i@x.com', ttlSeconds: 3600 }));
    expect(res.status).toBe(403);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(inviteFindFirst).not.toHaveBeenCalled();
    expect(inviteCreate).not.toHaveBeenCalled();
    expect(inviteUpdate).not.toHaveBeenCalled();
  });
});

// ─────── Issuer: validation ──────────────────────────────────────────────

describe('POST /api/team/memberships/invite validation', () => {
  it('returns 400 for a malformed email', async () => {
    const { POST } = await import('@/app/api/team/memberships/invite/route');
    const res = await POST(jsonRequest({ email: 'not-an-email', ttlSeconds: 3600 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(inviteCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['ttlSeconds: -1', -1],
    ['ttlSeconds: 0.5', 0.5],
    ['ttlSeconds: 99999999', 99999999],
  ])('returns 400 for bad ttlSeconds (%s)', async (_label, ttlSeconds) => {
    const { POST } = await import('@/app/api/team/memberships/invite/route');
    const res = await POST(jsonRequest({ email: 'i@x.com', ttlSeconds }));
    expect(res.status).toBe(400);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(inviteCreate).not.toHaveBeenCalled();
  });
});

// ─────── Issuer: happy path ──────────────────────────────────────────────

describe('POST /api/team/memberships/invite happy path', () => {
  it('creates an invite, sends email, and writes an audit event with the new URL', async () => {
    const { POST } = await import('@/app/api/team/memberships/invite/route');
    const res = await POST(jsonRequest({ email: 'i@x.com', ttlSeconds: 3600 }));

    expect(res.status).toBe(201);

    expect(requireTeamRoleMock).toHaveBeenCalledTimes(1);
    expect(fromForMock).toHaveBeenCalledWith('invites');
    expect(fromForMock).toHaveBeenCalledTimes(1);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const firstCall = sendEmailMock.mock.calls[0];
    const emailArgs = (firstCall ? firstCall[0] : undefined) as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(emailArgs.to).toBe('i@x.com');
    expect(emailArgs.subject).toContain('Acme Inc');
    expect(emailArgs.html).toContain('/invite/');
    expect(emailArgs.html).not.toContain('/team/invite/accept?token=');
    expect(emailArgs.text).toContain('/invite/');
    expect(emailArgs.text).not.toContain('/team/invite/accept?token=');

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'inviter-1',
        actorTeamId: 'team-1',
        action: 'invite.create',
        resourceType: 'invite',
        resourceId: 'invite-new',
        metadata: { email: 'i@x.com', ttlSeconds: 3600 },
        ipAddress: '203.0.113.7',
      }),
    );

    const body = await res.json();
    expect(body.id).toBe('invite-new');
    expect(body.email).toBe('i@x.com');
    expect(body.teamId).toBe('team-1');
    expect(typeof body.expiresAt).toBe('string');
    expect(typeof body.createdAt).toBe('string');
  });
});

// ─────── Issuer: idempotent refresh ──────────────────────────────────────

describe('POST /api/team/memberships/invite idempotent refresh', () => {
  it('refreshes an existing pending row in place and re-sends the email', async () => {
    const seededTokenHash = 'old-seeded-token-hash-1234';
    inviteFindFirst.mockResolvedValueOnce({
      id: 'invite-existing',
      acceptedAt: null,
      createdAt: new Date('2026-07-22T09:00:00Z'),
      tokenHash: seededTokenHash,
      teamId: 'team-1',
      email: 'i@x.com',
      expiresAt: new Date('2026-07-22T10:00:00Z'),
      invitedByUserId: 'inviter-1',
    });
    inviteUpdate.mockResolvedValueOnce({
      id: 'invite-existing',
      createdAt: new Date('2026-07-22T09:00:00Z'),
    });

    const { POST } = await import('@/app/api/team/memberships/invite/route');
    const res = await POST(jsonRequest({ email: 'i@x.com', ttlSeconds: 3600 }));
    expect(res.status).toBe(201);

    // create() must NOT run — we refreshed in place.
    expect(inviteCreate).not.toHaveBeenCalled();
    expect(inviteDeleteMany).not.toHaveBeenCalled();

    // update() runs once with the existing row id and a fresh tokenHash.
    expect(inviteUpdate).toHaveBeenCalledTimes(1);
    const updateCall = inviteUpdate.mock.calls[0];
    const updateArgs = (updateCall ? updateCall[0] : undefined) as {
      where: { id: string };
      data: { tokenHash: string; expiresAt: Date; invitedByUserId: string };
    };
    expect(updateArgs.where.id).toBe('invite-existing');
    expect(updateArgs.data.tokenHash).not.toBe(seededTokenHash);
    expect(updateArgs.data.invitedByUserId).toBe('inviter-1');

    // sendEmail fires once with the new URL (proof: the URL contains a token
    // and the audit's resourceId is the existing row's id).
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'invite-existing' }),
    );

    const body = await res.json();
    expect(body.id).toBe('invite-existing');
  });
});

// ─────── GET /api/invites/[token] lookup ─────────────────────────────────

describe('GET /api/invites/[token] lookup', () => {
  function buildInviteRow(
    overrides: Partial<{
      id: string;
      email: string;
      role: string;
      teamId: string;
      expiresAt: Date;
      acceptedAt: Date | null;
    }> = {},
  ) {
    return {
      id: 'invite-1',
      email: 'invitee@example.com',
      role: 'member',
      teamId: 'team-1',
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      ...overrides,
    };
  }

  it('returns 404 invalid when no row matches the tokenHash', async () => {
    inviteFindFirst.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/invites/[token]/route');
    const res = await GET(new Request('http://x/api/invites/abc'), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe('invalid');
    // No tokenHash or invitedByUserId leakage.
    const payload = JSON.stringify(body);
    expect(payload).not.toContain('tokenHash');
    expect(payload).not.toContain('invitedByUserId');
  });

  it('returns 410 consumed when acceptedAt is set', async () => {
    inviteFindFirst.mockResolvedValueOnce(
      buildInviteRow({ acceptedAt: new Date('2026-07-22T10:00:00Z') }),
    );
    const { GET } = await import('@/app/api/invites/[token]/route');
    const res = await GET(new Request('http://x/api/invites/abc'), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.status).toBe('consumed');
  });

  it('returns 200 pending with no tokenHash leak and existingUser=true when the email matches a User', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInviteRow());
    teamFindUnique.mockResolvedValueOnce({ name: 'Acme Inc' });
    userFindUnique.mockResolvedValueOnce({ id: 'user-existing' });
    const { GET } = await import('@/app/api/invites/[token]/route');
    const res = await GET(new Request('http://x/api/invites/abc'), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(body.teamName).toBe('Acme Inc');
    expect(body.existingUser).toBe(true);
    expect(body.email).toBe('invitee@example.com');
    const payload = JSON.stringify(body);
    expect(payload).not.toContain('tokenHash');
    expect(payload).not.toContain('invitedByUserId');
    expect(payload).not.toContain('invite-1');
  });

  it('returns 200 pending with existingUser=false when the email has no User', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInviteRow());
    teamFindUnique.mockResolvedValueOnce({ name: 'Acme Inc' });
    userFindUnique.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/invites/[token]/route');
    const res = await GET(new Request('http://x/api/invites/abc'), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.existingUser).toBe(false);
  });
});

// ─────── POST /api/invites/[token]/accept ────────────────────────────────

describe('POST /api/invites/[token]/accept flow', () => {
  function buildInvite(
    overrides: Partial<{
      id: string;
      email: string;
      role: string;
      teamId: string;
      expiresAt: Date;
      acceptedAt: Date | null;
      invitedByUserId: string;
    }> = {},
  ) {
    return {
      id: 'invite-1',
      email: 'invitee@example.com',
      role: 'member',
      teamId: 'team-1',
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      invitedByUserId: 'inviter-1',
      ...overrides,
    };
  }

  function postRequest(body: unknown) {
    return new Request('http://x/api/invites/abc/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function makeAuthResponse(body: unknown, cookies: string[]): Response {
    const headers = new Headers();
    for (const c of cookies) headers.append('set-cookie', c);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers,
    });
  }

  it('400 when the body is not JSON', async () => {
    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(
      new Request('http://x/api/invites/abc/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      { params: Promise.resolve({ token: 'abc' }) },
    );
    expect(res.status).toBe(400);
  });

  it('400 when password fails zod (too short)', async () => {
    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'short' }), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 invalid when no row matches the tokenHash', async () => {
    inviteFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw' }), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe('invalid');
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(inviteDelete).not.toHaveBeenCalled();
  });

  it('returns 410 consumed when acceptedAt is set', async () => {
    inviteFindFirst.mockResolvedValueOnce(
      buildInvite({ acceptedAt: new Date('2026-07-22T10:00:00Z') }),
    );
    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw' }), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(410);
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(inviteDelete).not.toHaveBeenCalled();
  });

  it('returns 200, members the existing user (signin branch), deletes the invite, writes audit, sends email, and forwards Set-Cookie', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInvite());
    teamFindUnique.mockResolvedValueOnce({ id: 'team-1', name: 'Acme Inc' });
    userFindUnique.mockResolvedValueOnce({ id: 'user-existing' });
    membershipFindUnique.mockResolvedValueOnce(null);
    signInEmailMock.mockResolvedValueOnce(
      makeAuthResponse({ user: { id: 'user-existing' }, session: { id: 'sess-1' } }, [
        'better-auth.session_token=abc; Path=/; HttpOnly',
      ]),
    );

    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw' }), {
      params: Promise.resolve({ token: 'abc' }),
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('better-auth.session_token=abc');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.redirect).toBe('/dashboard');

    // Existing-user path: no User was created, signUpEmail was not called.
    expect(signUpEmailMock).not.toHaveBeenCalled();
    expect(signInEmailMock).toHaveBeenCalledTimes(1);
    // Membership created on the invited team — NOT a personal workspace.
    expect(membershipCreate).toHaveBeenCalledTimes(1);
    const createArgs = membershipCreate.mock.calls[0]?.[0] as {
      data: { teamId: string; role: string };
    };
    expect(createArgs.data.teamId).toBe('team-1');
    expect(createArgs.data.role).toBe('member');
    // Invite row was deleted (post-success).
    expect(inviteDelete).toHaveBeenCalledTimes(1);
    // Audit event with `via: 'signin'`.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invite.accept',
        resourceId: 'invite-1',
        metadata: expect.objectContaining({ via: 'signin' }),
      }),
    );
    // Confirmation email sent exactly once to the invite email.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sentArg = (sendEmailMock.mock.calls[0]?.[0] ?? {}) as {
      to: string;
      subject: string;
    };
    expect(sentArg.to).toBe('invitee@example.com');
    expect(sentArg.subject).toContain('Acme Inc');
  });

  it('returns 200, creates the user (signup branch), binds to the invited team (not a personal workspace), and writes audit `via: signup`', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInvite());
    teamFindUnique.mockResolvedValueOnce({ id: 'team-1', name: 'Acme Inc' });
    // No matching User — fresh signup path.
    userFindUnique.mockResolvedValueOnce(null);
    // The Better Auth create hook has already attached the fresh account to
    // its provisional workspace before the invitation transaction runs.
    membershipFindUnique.mockResolvedValueOnce({ teamId: 'default-team' });
    signUpEmailMock.mockResolvedValueOnce(
      makeAuthResponse(
        {
          user: { id: 'user-fresh', email: 'invitee@example.com' },
          session: { id: 'sess-2' },
        },
        ['better-auth.session_token=fresh; Path=/; HttpOnly'],
      ),
    );

    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw', name: 'Invitee Person' }), {
      params: Promise.resolve({ token: 'abc' }),
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('better-auth.session_token=fresh');
    expect(signInEmailMock).not.toHaveBeenCalled();
    expect(signUpEmailMock).toHaveBeenCalledTimes(1);
    expect(membershipCreate).toHaveBeenCalledTimes(1);
    const createArgs = membershipCreate.mock.calls[0]?.[0] as {
      data: { teamId: string; role: string; userId: string };
    };
    expect(createArgs.data.teamId).toBe('team-1');
    expect(createArgs.data.role).toBe('member');
    expect(membershipDeleteMany).toHaveBeenCalledTimes(1);
    expect(workspaceUpsert).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      create: { id: 'team-1', name: 'Acme Inc', ownerUserId: null },
      update: {},
    });
    expect(workspaceMemberDeleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'default-team', userId: 'user-fresh' },
    });
    expect(workspaceDeleteMany).toHaveBeenCalledWith({
      where: { id: 'default-team', ownerUserId: 'user-fresh' },
    });
    expect(inviteDelete).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ via: 'signup' }),
      }),
    );
  });

  it('returns 409 cross-team when a different teamId is already on the user', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInvite());
    teamFindUnique.mockResolvedValueOnce({ id: 'team-1', name: 'Acme Inc' });
    userFindUnique.mockResolvedValueOnce({ id: 'user-existing' });
    membershipFindUnique.mockResolvedValueOnce({
      id: 'mem-other',
      teamId: 'team-other',
    });

    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw' }), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(409);
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(inviteDelete).not.toHaveBeenCalled();
  });

  it('returns 409 when a different signed-in user is requesting acceptance', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInvite());
    teamFindUnique.mockResolvedValueOnce({ id: 'team-1', name: 'Acme Inc' });
    userFindUnique.mockResolvedValueOnce({ id: 'user-existing' });
    getSessionMock.mockResolvedValueOnce({
      user: { id: 'user-other', email: 'someoneelse@example.com' },
      session: { id: 'sess-other' },
    });

    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw' }), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(409);
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it('returns 401 when signInEmail fails (bad password on existing user)', async () => {
    inviteFindFirst.mockResolvedValueOnce(buildInvite());
    teamFindUnique.mockResolvedValueOnce({ id: 'team-1', name: 'Acme Inc' });
    userFindUnique.mockResolvedValueOnce({ id: 'user-existing' });
    signInEmailMock.mockResolvedValueOnce(new Response('bad', { status: 401 }));

    const { POST } = await import('@/app/api/invites/[token]/accept/route');
    const res = await POST(postRequest({ password: 'longenoughpw' }), {
      params: Promise.resolve({ token: 'abc' }),
    });
    expect(res.status).toBe(401);
    expect(membershipCreate).not.toHaveBeenCalled();
  });
});
