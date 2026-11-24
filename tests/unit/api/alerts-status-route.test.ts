// @vitest-environment node
// Focused tests for the workspace-scoped alert status mutation.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  requireMember: vi.fn(),
  sameOrigin: vi.fn(),
  setRequestAuth: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: { alert: { findFirst: mocks.findFirst, updateMany: mocks.updateMany } },
}));
vi.mock('@/lib/business/alert-workspace-access', () => ({
  requireAlertWorkspaceMember: mocks.requireMember,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: mocks.setRequestAuth,
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

import { POST } from '@/app/api/alerts/[id]/status/route';

const STAMP = new Date('2026-11-08T12:00:00.000Z');
const CONTEXT = {
  user: { id: 'user-1' },
  workspaceId: 'workspace-1',
  workspaceMemberId: 'member-1',
};

type TestStatus = 'open' | 'in_progress' | 'resolved' | 'false_positive';

interface TestAlertRow {
  id: string;
  status: TestStatus;
  statusChangedAt: Date | null;
  acknowledgedAt: Date | null;
  snoozedUntil: Date | null;
  falsePositiveReason: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closingNote: string | null;
  reopenedAt: Date | null;
  reopenedBy: string | null;
  reopenReason: string | null;
}

function makeRow(overrides: Partial<TestAlertRow> = {}): TestAlertRow {
  return {
    id: 'alert-1',
    status: 'open',
    statusChangedAt: null,
    acknowledgedAt: null,
    snoozedUntil: null,
    falsePositiveReason: null,
    closedAt: null,
    closedBy: null,
    closingNote: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    ...overrides,
  };
}

function makeRequest(body: unknown, id = 'alert-1'): Request {
  return new Request(`https://app.example/api/alerts/${id}/status`, {
    method: 'POST',
    headers: { origin: 'https://app.example', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown, id = 'alert-1'): Promise<Response> {
  return POST(makeRequest(body, id), { params: Promise.resolve({ id }) });
}

describe('POST /api/alerts/[id]/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOrigin.mockReturnValue(true);
    mocks.requireMember.mockResolvedValue(CONTEXT);
    mocks.findFirst.mockResolvedValue(makeRow());
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('rejects cross-origin requests before authentication or database access', async () => {
    mocks.sameOrigin.mockReturnValue(false);

    const response = await post({ status: 'in_progress' });

    expect(response.status).toBe(403);
    expect(mocks.requireMember).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rejects invalid statuses and missing false-positive reasons without a write', async () => {
    const invalidStatus = await post({ status: 'snoozed' });
    const missingReason = await post({ status: 'false_positive', reason: '   ' });

    expect(invalidStatus.status).toBe(400);
    expect(missingReason.status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rejects status-specific text longer than 500 characters without a write', async () => {
    const longText = 'x'.repeat(501);
    const longNote = await post({ status: 'resolved', note: longText });
    const longReason = await post({ status: 'false_positive', reason: longText });

    expect(longNote.status).toBe(400);
    expect(longReason.status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated and nonmember callers without reading or writing alerts', async () => {
    mocks.requireMember.mockRejectedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }));
    const unauthenticated = await post({ status: 'in_progress' });
    mocks.requireMember.mockRejectedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
    const nonmember = await post({ status: 'in_progress' });

    expect(unauthenticated.status).toBe(401);
    expect(nonmember.status).toBe(404);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('returns the saved status and scopes lookup and compare-and-update to the active workspace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STAMP);
    mocks.findFirst
      .mockResolvedValueOnce(makeRow())
      .mockResolvedValueOnce(makeRow({ status: 'in_progress', statusChangedAt: STAMP }));

    const response = await post({ status: 'in_progress' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'in_progress', statusChangedAt: STAMP.toISOString() });
    expect(mocks.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'alert-1', teamId: 'workspace-1' },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'alert-1', teamId: 'workspace-1', status: 'open' },
        data: { status: 'in_progress', statusChangedAt: STAMP },
      }),
    );
    vi.useRealTimers();
  });

  it('returns a conflict when another status transition wins the scoped compare-and-update', async () => {
    mocks.findFirst
      .mockResolvedValueOnce(makeRow())
      .mockResolvedValueOnce(makeRow({ status: 'resolved' }));
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await post({ status: 'in_progress' });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: 'status_conflict' });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'alert-1', teamId: 'workspace-1', status: 'open' },
      }),
    );
  });

  it('hides missing and other-workspace alerts behind the same 404 without writing', async () => {
    mocks.findFirst.mockResolvedValueOnce(null);

    const response = await post({ status: 'resolved' }, 'alert-outside-workspace');

    expect(response.status).toBe(404);
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'alert-outside-workspace', teamId: 'workspace-1' } }),
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('trims and stores a false-positive reason with a server timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STAMP);
    mocks.findFirst
      .mockResolvedValueOnce(makeRow())
      .mockResolvedValueOnce(
        makeRow({ status: 'false_positive', statusChangedAt: STAMP, falsePositiveReason: 'confirmed duplicate' }),
      );

    const response = await post({ status: 'false_positive', reason: '  confirmed duplicate  ' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'false_positive', falsePositiveReason: 'confirmed duplicate' });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'false_positive',
          statusChangedAt: STAMP,
          falsePositiveReason: 'confirmed duplicate',
        },
      }),
    );
    vi.useRealTimers();
  });

  it('keeps the optional trimmed close note and stamps the resolving caller', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STAMP);
    mocks.findFirst
      .mockResolvedValueOnce(makeRow())
      .mockResolvedValueOnce(
        makeRow({ status: 'resolved', statusChangedAt: STAMP, closedAt: STAMP, closedBy: 'user-1', closingNote: 'patch shipped' }),
      );

    const response = await post({ status: 'resolved', note: '  patch shipped  ' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'resolved',
      statusChangedAt: STAMP.toISOString(),
      closedAt: STAMP.toISOString(),
      closedBy: 'user-1',
      closingNote: 'patch shipped',
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'resolved',
          statusChangedAt: STAMP,
          closedAt: STAMP,
          closedBy: 'user-1',
          closingNote: 'patch shipped',
        },
      }),
    );
    vi.useRealTimers();
  });

  it('reopens by clearing stale close and false-positive fields and recording the actor and time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STAMP);
    const snooze = new Date('2026-11-20T12:00:00.000Z');
    mocks.findFirst
      .mockResolvedValueOnce(
        makeRow({
          status: 'resolved',
          falsePositiveReason: 'stale reason',
          closedAt: new Date('2026-11-01T12:00:00.000Z'),
          closedBy: 'user-2',
          closingNote: 'stale note',
          snoozedUntil: snooze,
        }),
      )
      .mockResolvedValueOnce(
        makeRow({
          status: 'open',
          statusChangedAt: STAMP,
          snoozedUntil: snooze,
          reopenedAt: STAMP,
          reopenedBy: 'user-1',
        }),
      );

    const response = await post({ status: 'open' });
    const body = await response.json();
    const write = mocks.updateMany.mock.calls[0]?.[0];

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'open',
      statusChangedAt: STAMP.toISOString(),
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
      reopenedAt: STAMP.toISOString(),
      reopenedBy: 'user-1',
      reopenReason: null,
      snoozedUntil: snooze.toISOString(),
    });
    expect(write?.data).toMatchObject({
      status: 'open',
      statusChangedAt: STAMP,
      falsePositiveReason: null,
      closedAt: null,
      closedBy: null,
      closingNote: null,
      reopenedAt: STAMP,
      reopenedBy: 'user-1',
      reopenReason: null,
    });
    expect(write?.data).not.toHaveProperty('snoozedUntil');
    vi.useRealTimers();
  });
});
