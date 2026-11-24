// @vitest-environment node
// Unit tests for src/lib/business/team-notifications.ts:
//   - deliverCriticalNotification(): mock global.fetch and assert the
//     delivery-row write (responseCode / latencyMs / errorMessage) on the
//     three branches: 2xx, non-2xx, fetch-throw.
//   - testTeamNotification(): assert the no-config branch's outcome shape.
//   - zod contract round-trip for the three shapes the route handler emits.
//
// We do NOT dance around Prisma — the implementation is `server-only` and
// reads `prisma.teamNotificationConfig.{findUnique,upsert,create}` plus
// `prisma.teamNotificationDelivery.{findMany,create,deleteMany}`. A clean
// repo-level mock is correct here.
//
// Use `vi.hoisted` so the mock factory can reference vi.fn() instances that
// exist outside the factory closure (the factory is hoisted above top-level
// const declarations, so bare `const x = vi.fn()` is undefined at hoist time).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  configFindUnique: vi.fn(),
  configUpsert: vi.fn(),
  deliveryFindMany: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryDeleteMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    teamNotificationConfig: {
      findUnique: mocks.configFindUnique,
      upsert: mocks.configUpsert,
    },
    teamNotificationDelivery: {
      findMany: mocks.deliveryFindMany,
      create: mocks.deliveryCreate,
      deleteMany: mocks.deliveryDeleteMany,
    },
  },
}));

import {
  deliverCriticalNotification,
  testTeamNotification,
} from '@/lib/business/team-notifications';

describe('deliverCriticalNotification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.configFindUnique.mockReset();
    mocks.configUpsert.mockReset();
    mocks.deliveryFindMany.mockReset();
    mocks.deliveryCreate.mockReset();
    mocks.deliveryDeleteMany.mockReset();
    mocks.deliveryFindMany.mockResolvedValue([]); // no-op prune
    mocks.deliveryDeleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a 2xx row with responseCode + latency and no error', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-1',
      teamId: 't-1',
      webhookUrl: 'https://hooks.example.com/abc',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverCriticalNotification({
      teamId: 't-1',
      alert: {
        alertId: 'alert-1',
        title: 'Test',
        severity: 'critical',
        link: 'http://localhost:3000/alerts/alert-1',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(typeof result.latencyMs).toBe('number');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://hooks.example.com/abc');
    expect(calledInit.method).toBe('POST');
    expect(JSON.parse(String(calledInit.body))).toMatchObject({
      alertId: 'alert-1',
      title: 'Test',
      severity: 'critical',
      link: 'http://localhost:3000/alerts/alert-1',
      text: '[critical] Test — http://localhost:3000/alerts/alert-1',
    });

    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.deliveryCreate.mock.calls[0][0] as {
      data: {
        teamId: string;
        alertId: string;
        responseCode: number;
        latencyMs: number;
        errorMessage: string | null;
      };
    };
    expect(createArg.data.teamId).toBe('t-1');
    expect(createArg.data.alertId).toBe('alert-1');
    expect(createArg.data.responseCode).toBe(200);
    expect(createArg.data.errorMessage).toBeNull();
    expect(typeof createArg.data.latencyMs).toBe('number');
  });

  it('writes a non-2xx row with responseCode + an HTTP error message', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-1',
      teamId: 't-1',
      webhookUrl: 'https://hooks.example.com/abc',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
      }),
    );

    const result = await deliverCriticalNotification({
      teamId: 't-1',
      alert: { alertId: 'a-2', title: 'Test', severity: 'critical', link: 'http://x/a-2' },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('HTTP 500');

    const createArg = mocks.deliveryCreate.mock.calls[0][0] as {
      data: { responseCode: number; errorMessage: string | null };
    };
    expect(createArg.data.responseCode).toBe(500);
    expect(createArg.data.errorMessage).toBe('HTTP 500');
  });

  it('writes a null-responseCode row with the throw message when fetch throws', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-1',
      teamId: 't-1',
      webhookUrl: 'https://hooks.example.com/abc',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await deliverCriticalNotification({
      teamId: 't-1',
      alert: { alertId: 'a-3', title: 'Test', severity: 'critical', link: 'http://x/a-3' },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('ECONNREFUSED');

    const createArg = mocks.deliveryCreate.mock.calls[0][0] as {
      data: { responseCode: number | null; errorMessage: string | null };
    };
    expect(createArg.data.responseCode).toBeNull();
    expect(createArg.data.errorMessage).toBe('ECONNREFUSED');
  });

  it('records a no-config attempt when the team has no saved webhook', async () => {
    mocks.configFindUnique.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await deliverCriticalNotification({
      teamId: 't-1',
      alert: { alertId: 'a-4', title: 'Test', severity: 'critical', link: 'http://x/a-4' },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no webhook/i);

    const createArg = mocks.deliveryCreate.mock.calls[0][0] as {
      data: { responseCode: number | null; latencyMs: number; errorMessage: string | null };
    };
    expect(createArg.data.responseCode).toBeNull();
    expect(createArg.data.errorMessage).toMatch(/no webhook/i);
  });
});

describe('testTeamNotification', () => {
  beforeEach(() => {
    mocks.configFindUnique.mockReset();
    mocks.deliveryFindMany.mockReset();
    mocks.deliveryCreate.mockReset();
    mocks.deliveryDeleteMany.mockReset();
    mocks.deliveryFindMany.mockResolvedValue([]);
    mocks.deliveryDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('returns the no-webhook-configured outcome when the team has no row', async () => {
    mocks.configFindUnique.mockResolvedValue(null);
    const result = await testTeamNotification('t-no-row');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no webhook/i);
    expect(result.status).toBeNull();
  });
});

describe('zod contract round-trip', () => {
  it('accepts a valid Slack-compatible URL', async () => {
    const { NotificationSetBody, NotificationGetResponse, NotificationTestResponse } = await import(
      '@/lib/contracts/team-notifications'
    );
    expect(
      NotificationSetBody.safeParse({ url: 'https://hooks.slack.com/services/T0/B0/x' }).success,
    ).toBe(true);

    expect(
      NotificationGetResponse.safeParse({
        config: {
          id: 'cfg-1',
          teamId: 't-1',
          webhookUrl: 'https://hooks.slack.com/services/T0/B0/x',
          createdAt: '2026-07-25T00:00:00.000Z',
          updatedAt: '2026-07-25T00:00:00.000Z',
          createdByUserId: null,
        },
        deliveries: [],
      }).success,
    ).toBe(true);

    expect(
      NotificationTestResponse.safeParse({
        ok: true,
        status: 200,
        latencyMs: 42,
        error: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a 2049-char URL', async () => {
    const { NotificationSetBody } = await import('@/lib/contracts/team-notifications');
    const tooLong = `https://example.com/${'a'.repeat(2049)}`;
    expect(NotificationSetBody.safeParse({ url: tooLong }).success).toBe(false);
  });
});
