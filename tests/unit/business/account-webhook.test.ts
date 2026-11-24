// @vitest-environment node
// Unit tests for src/lib/business/account-webhook.ts after the
// delivery-history refactor:
//   - testUserWebhook() with a saved URL writes a UserWebhookDelivery row
//     (`payloadKind: 'test'`, responseCode, latencyMs, snippet matching the
//     upstream body's first 256 chars).
//   - testUserWebhook() with no config writes a no-config delivery row
//     (`snippet: 'no webhook configured'`, responseCode null, latencyMs 0)
//     AND surfaces the same shape through its return value.
//   - getUserWebhookDeliveries() returns rows in attemptedAt-desc order,
//     scoped to the caller's userId.
//   - zod contract round-trip on UserWebhookGetResponse (the new shape) and
//     UserWebhookDeliveryItem rejects a bad payloadKind.
//
// We mock `@/lib/db` (server-only) and global fetch the same way
// team-notifications.test.ts does. Prisma's full type surface isn't
// exercised — we only need the callsites that the new delivery code
// touches.

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
    userWebhookConfig: {
      findUnique: mocks.configFindUnique,
      upsert: mocks.configUpsert,
    },
    userWebhookDelivery: {
      findMany: mocks.deliveryFindMany,
      create: mocks.deliveryCreate,
      deleteMany: mocks.deliveryDeleteMany,
    },
  },
}));

import {
  getUserWebhookDeliveries,
  testUserWebhook,
  upsertUserWebhookUrl,
} from '@/lib/business/account-webhook';
import {
  UserWebhookDeliveryItem,
  UserWebhookGetResponse,
  UserWebhookTestResponse,
} from '@/lib/contracts/account-webhook';

describe('account-webhook deliveries', () => {
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

  it('testUserWebhook writes a delivery row on a 2xx response', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-1',
      userId: 'u-1',
      webhookUrl: 'https://hooks.example.com/u1',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok-from-upstream'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testUserWebhook('u-1');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    const row = mocks.deliveryCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(row.userId).toBe('u-1');
    expect(row.targetUrl).toBe('https://hooks.example.com/u1');
    expect(row.payloadKind).toBe('test');
    expect(row.alertId).toBeNull();
    expect(row.responseCode).toBe(200);
    expect(row.snippet).toBe('ok-from-upstream');
  });

  it('testUserWebhook writes a delivery row on a non-2xx response', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-2',
      userId: 'u-2',
      webhookUrl: 'https://hooks.example.com/u2',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('upstream blew up'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testUserWebhook('u-2');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('upstream blew up');

    const row = mocks.deliveryCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(row.responseCode).toBe(500);
    expect(row.snippet).toBe('upstream blew up');
  });

  it('testUserWebhook writes a fetch-throw delivery row when fetch rejects', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-3',
      userId: 'u-3',
      webhookUrl: 'https://hooks.example.com/u3',
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testUserWebhook('u-3');

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('ECONNRESET');

    const row = mocks.deliveryCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(row.responseCode).toBeNull();
    expect(row.snippet).toBe('ECONNRESET');
  });

  it('testUserWebhook writes a no-config delivery row when the URL is null', async () => {
    mocks.configFindUnique.mockResolvedValue({
      id: 'cfg-4',
      userId: 'u-4',
      webhookUrl: null,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await testUserWebhook('u-4');

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.latencyMs).toBe(0);
    expect(result.error).toBe('no webhook configured');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.deliveryCreate).toHaveBeenCalledTimes(1);
    const row = mocks.deliveryCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(row.userId).toBe('u-4');
    expect(row.payloadKind).toBe('test');
    expect(row.responseCode).toBeNull();
    expect(row.latencyMs).toBe(0);
    expect(row.snippet).toBe('no webhook configured');
  });

  it('getUserWebhookDeliveries scopes by userId and returns desc-by-attemptedAt', async () => {
    mocks.deliveryFindMany.mockResolvedValue([
      {
        id: 'd-3',
        userId: 'u-5',
        attemptedAt: new Date('2026-07-30T12:00:00.000Z'),
        targetUrl: 'https://hooks.example.com/u5',
        payloadKind: 'alert',
        alertId: 'alert-3',
        responseCode: 200,
        latencyMs: 42,
        snippet: 'ok',
      },
    ]);

    await getUserWebhookDeliveries('u-5');

    expect(mocks.deliveryFindMany).toHaveBeenCalledWith({
      where: { userId: 'u-5' },
      orderBy: { attemptedAt: 'desc' },
      take: 20,
    });
  });

  it('upsertUserWebhookUrl round-trips through prisma with the nullable URL', async () => {
    mocks.configUpsert.mockResolvedValue({
      id: 'cfg-6',
      userId: 'u-6',
      webhookUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await upsertUserWebhookUrl({ userId: 'u-6', url: null });

    expect(mocks.configUpsert).toHaveBeenCalledWith({
      where: { userId: 'u-6' },
      create: { userId: 'u-6', webhookUrl: null },
      update: { webhookUrl: null },
    });
  });
});

describe('account-webhook contracts', () => {
  it('UserWebhookDeliveryItem rejects an unknown payloadKind', () => {
    const bad = UserWebhookDeliveryItem.safeParse({
      id: 'd-x',
      attemptedAt: new Date().toISOString(),
      targetUrl: 'https://hooks.example.com',
      payloadKind: 'nope',
      alertId: null,
      responseCode: 200,
      latencyMs: 10,
      snippet: 'ok',
    });
    expect(bad.success).toBe(false);
  });

  it('UserWebhookGetResponse accepts the new shape with deliveries', () => {
    const ok = UserWebhookGetResponse.parse({
      url: 'https://hooks.example.com/u',
      updatedAt: new Date().toISOString(),
      deliveries: [
        {
          id: 'd-1',
          attemptedAt: new Date().toISOString(),
          targetUrl: 'https://hooks.example.com/u',
          payloadKind: 'alert',
          alertId: 'a-1',
          responseCode: 200,
          latencyMs: 10,
          snippet: 'ok',
        },
        {
          id: 'd-2',
          attemptedAt: new Date().toISOString(),
          targetUrl: 'https://hooks.example.com/u',
          payloadKind: 'test',
          alertId: null,
          responseCode: null,
          latencyMs: 0,
          snippet: null,
        },
      ],
    });
    expect(ok.deliveries).toHaveLength(2);
  });

  it('UserWebhookTestResponse unchanged shape still validates', () => {
    const ok = UserWebhookTestResponse.parse({
      ok: true,
      status: 200,
      latencyMs: 100,
      error: null,
    });
    expect(ok).toEqual({ ok: true, status: 200, latencyMs: 100, error: null });
  });
});
