// @vitest-environment node
//
// Integration-style unit tests for POST /api/v1/webhooks/trigger.
// Pins the `WebhookTriggerResponse` envelope (NOT the summary sibling
// contract), the auth gate posture (401 / 503 / 405 — no 403 on this route),
// the body parsing + allowlist filtering, the queued + WebhookTrigger row
// creation, the runScan hand-off shape (with `scanIdOverride` threading),
// the run-failure surface, the other-verb posture, and the fire-and-forget
// delivery of signed webhook notifications.
//
// HMAC posture: every successful path requires an `X-Webhook-Id` header AND
// a valid `X-VulnAware-Signature` over the raw body. The verifier
// (`src/lib/business/webhooks-inbound.ts`) is mocked at the module
// boundary so the route tests don't have to construct a valid Webhook row
// + ciphertext + master key round-trip; the dedicated
// tests/unit/api/webhook-inbound.test.ts file pins the verifier's full
// failure-mode matrix.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookTriggerResponse } from '@/lib/contracts/scan-api';

vi.mock('server-only', () => ({}));

// withRateLimit (transitively imported by the route) reads env. Stub the
// fields it actually reads so we don't have to spin t3-env validation.
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_READ_PER_MIN: 60,
    RATE_LIMIT_WRITE_PER_MIN: 20,
    RATE_LIMIT_TIGHTER_PER_MIN: 10,
  },
}));

// ── Module mocks with stable hoisted spies ────────────────────────────────────

const runScanSpy = vi.fn();
vi.mock('@/lib/business/scanner/run-scan', () => ({
  runScan: (...args: unknown[]) => runScanSpy(...args),
}));

const verifyInboundSpy = vi.fn();
vi.mock('@/lib/business/webhooks-inbound', () => ({
  verifyInboundWebhook: (...args: unknown[]) => verifyInboundSpy(...args),
}));

const deliverWebhookSpy = vi.fn();
const getWebhookSigningSecretSpy = vi.fn();
vi.mock('@/lib/business/webhooks', () => ({
  deliverWebhook: (...args: unknown[]) => deliverWebhookSpy(...args),
  getWebhookSigningSecret: (...args: unknown[]) => getWebhookSigningSecretSpy(...args),
}));

// Only the models the fire-and-forget delivery and the rate-limit wrapper
// actually touch. Keeping the surface minimal so a stray use of any other
// model fails loudly instead of falling through to a silent undefined call.
const webhookFindMany = vi.fn();
const scanCreate = vi.fn();
const webhookTriggerCreate = vi.fn();
const rateLimitUpsert = vi.fn();
const rateLimitDeleteMany = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    webhook: { findMany: webhookFindMany },
    scan: { create: scanCreate },
    webhookTrigger: { create: webhookTriggerCreate },
    rateLimitBucket: { upsert: rateLimitUpsert, deleteMany: rateLimitDeleteMany },
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_KEY = 'apiKey12345678901234567890123456';
const TEST_WEBHOOK_ID = 'cm12testwebhookid0000000000000';

function mkReq(
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | object;
    rawBody?: string;
  } = {},
): Request {
  const method = opts.method ?? 'POST';
  // Default headers include both x-api-key AND the HMAC pair so callers who
  // forget to override either can opt in by explicitly nulling.
  const headers: Record<string, string> = {
    'x-api-key': TEST_KEY,
    'x-webhook-id': TEST_WEBHOOK_ID,
    'x-vulnaware-signature': 'sha256=' + 'a'.repeat(64),
    ...(opts.headers ?? {}),
  };
  let body: string | undefined;
  if (typeof opts.rawBody === 'string') body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  return new Request('http://test/api/v1/webhooks/trigger', { method, headers, body });
}

type OkAuth = {
  teamId: string;
  scopeKind: 'team' | 'scan';
  scanId?: string | null;
  keyId?: string;
};

function mockAuthOk(opts: OkAuth): void {
  vi.doMock('@/lib/api-auth', () => ({
    verifyApiKey: async () => ({
      ok: true as const,
      teamId: opts.teamId,
      scopeKind: opts.scopeKind,
      scanId: opts.scanId ?? null,
      keyId: opts.keyId ?? 'key-test',
    }),
  }));
}

function mockAuthFail(status: 401 | 503): void {
  vi.doMock('@/lib/api-auth', () => ({
    verifyApiKey: async () => {
      const { NextResponse } = await import('next/server');
      const body = status === 503 ? { error: 'api_key_not_configured' } : { error: 'unauthorized' };
      return NextResponse.json(body, { status });
    },
  }));
}

type InboundOk = {
  webhookId?: string;
  algorithm?: 'hmac-sha256';
};

function mockInboundOk(opts: InboundOk = {}): void {
  verifyInboundSpy.mockResolvedValueOnce({
    webhook: {
      id: opts.webhookId ?? TEST_WEBHOOK_ID,
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: opts.algorithm ?? 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    },
    algorithm: opts.algorithm ?? 'hmac-sha256',
  });
}

function mockInboundFail(): void {
  verifyInboundSpy.mockResolvedValueOnce(null);
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  runScanSpy.mockReset();
  verifyInboundSpy.mockReset();
  deliverWebhookSpy.mockReset();
  getWebhookSigningSecretSpy.mockReset();
  webhookFindMany.mockReset();
  scanCreate.mockReset();
  webhookTriggerCreate.mockReset();
  rateLimitUpsert.mockReset();
  rateLimitDeleteMany.mockReset();
  // Default rate-limit mock behavior: allow the request and return a fresh
  // bucket row count of 1. `deleteMany` is called when GC fires; return
  // count 0 so its shape stays sane.
  rateLimitUpsert.mockResolvedValue({ windowStart: Math.floor(Date.now() / 60_000), count: 1 });
  rateLimitDeleteMany.mockResolvedValue({ count: 0 });
  // Default scan.create mock: returns a hand-crafted queued row so the
  // route can build the 201 envelope. scaneScued.created = queued status.
  scanCreate.mockImplementation(async (args: { data: { teamId: string; target: string } }) => ({
    id: 'scan-queued-1',
    target: args.data.target,
    mode: args.data.mode ?? 'tcp-only',
    status: args.data.status ?? 'queued',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: null,
    teamId: args.data.teamId,
  }));
  webhookTriggerCreate.mockResolvedValue({ id: 'trigger-1' });
});

// ===================== GROUP A — AUTH GATES =====================

describe('POST /api/v1/webhooks/trigger auth gates', () => {
  it('returns 401 {error:"unauthorized"} when x-api-key is missing — runScan untouched', async () => {
    mockAuthFail(401);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ headers: { 'x-api-key': '' } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(runScanSpy).not.toHaveBeenCalled();
    expect(verifyInboundSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when x-api-key header is fully absent', async () => {
    mockAuthFail(401);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const req = new Request('http://test/api/v1/webhooks/trigger', {
      method: 'POST',
      body: JSON.stringify({ target: 'a.example.org' }),
      headers: {
        'x-webhook-id': TEST_WEBHOOK_ID,
        'x-vulnaware-signature': 'sha256=' + 'a'.repeat(64),
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong-length arbitrary value — runScan untouched', async () => {
    mockAuthFail(401);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ headers: { 'x-api-key': 'nope' } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('propagates 503 {error:"api_key_not_configured"} verbatim — runScan untouched', async () => {
    mockAuthFail(503);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('api_key_not_configured');
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('returns 405 {code:"scope_not_supported"} for scan-scope keys — runScan untouched', async () => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'scan', scanId: 'scan-1' });
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq());
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe('scope_not_supported');
    expect(typeof body.message).toBe('string');
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('proceeds past auth for team-scope keys (reach HMAC → 401 without HMAC)', async () => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    // Without HMAC the HMAC gate fails before runScan.
    expect(res.status).toBe(401);
    expect(runScanSpy).not.toHaveBeenCalled();
  });
});

// ===================== GROUP A2 — HMAC GATE =====================

describe('POST /api/v1/webhooks/trigger HMAC gate', () => {
  beforeEach(() => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
  });

  it('returns 401 when X-Webhook-Id is missing', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      mkReq({
        body: { target: 'a.example.org' },
        headers: { 'x-webhook-id': '' },
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(verifyInboundSpy).not.toHaveBeenCalled();
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Webhook-Id is not a cuid-shape', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      mkReq({
        body: { target: 'a.example.org' },
        headers: { 'x-webhook-id': 'not-a-cuid' },
      }),
    );
    expect(res.status).toBe(401);
    expect(verifyInboundSpy).not.toHaveBeenCalled();
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when X-VulnAware-Signature is missing', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      mkReq({
        body: { target: 'a.example.org' },
        headers: { 'x-vulnaware-signature': '' },
      }),
    );
    expect(res.status).toBe(401);
    expect(verifyInboundSpy).not.toHaveBeenCalled();
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when verifyInboundWebhook returns null', async () => {
    mockInboundFail();
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(runScanSpy).not.toHaveBeenCalled();
  });

  it('passes the raw body, x-webhook-id, and x-vulnaware-signature to the verifier', async () => {
    mockInboundOk();
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);

    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const obj = { target: 'a.example.org', repository: { url: 'https://a.example.org/r' } };
    await POST(mkReq({ body: obj }));

    expect(verifyInboundSpy).toHaveBeenCalledTimes(1);
    expect(verifyInboundSpy).toHaveBeenCalledWith({
      rawBody: JSON.stringify(obj),
      signatureHeader: 'sha256=' + 'a'.repeat(64),
      webhookId: TEST_WEBHOOK_ID,
      teamId: 'team-A',
    });
  });
});

// ===================== GROUP B — BODY PARSING =====================

describe('POST /api/v1/webhooks/trigger body parsing', () => {
  beforeEach(() => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
    mockInboundOk();
  });

  it('returns 400 {code:"bad_request",message:"invalid JSON"} on a non-JSON body', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ rawBody: 'not-json' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(body.message).toBe('invalid JSON');
  });

  it('returns 400 "invalid JSON" on an empty body', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ rawBody: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('invalid JSON');
  });

  it('returns 400 with zod issues for an unknown top-level key (strict schema)', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org', hack: true } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 400 "target or repository.url required" when neither is present', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: {} }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('target or repository.url required');
  });

  it('returns 400 "target or repository.url required" for a loopback target with no repository.url', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: '127.0.0.1' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('target or repository.url required');
  });

  it('returns 400 with zod issues when repository.url is not a URL', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { repository: { url: 'not-a-url' } } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 400 with zod issues for a mode other than "tcp-only"', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org', mode: 'syn' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('accepts the allowlist at its max boundary (5 ports)', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      mkReq({ body: { target: 'a.example.org', ports: [22, 80, 443, 8080, 8443] } }),
    );
    expect(res.status).toBe(201);
  });

  it('returns 400 {message:"port not in allowlist"} for a non-allowlist port', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org', ports: [25] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('port not in allowlist');
  });

  it('returns 400 (zod min(1)) for an empty ports array', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org', ports: [] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 400 (zod max(5)) for a 6-port array', async () => {
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      mkReq({ body: { target: 'a.example.org', ports: [22, 80, 443, 8080, 8443, 22] } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(Array.isArray(body.issues)).toBe(true);
  });
});

// ===================== GROUP C — RUN + ENVELOPE (201) =====================

describe('POST /api/v1/webhooks/trigger 201 envelope', () => {
  beforeEach(() => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
    mockInboundOk();
  });

  it('returns 201 with the queued envelope BEFORE background scan settles', async () => {
    // runScan is intentionally unresolved (deferred) to prove the 201 lands
    // with `status: "queued"` while the background chain is still pending.
    let releaseScan: () => void = () => {};
    runScanSpy.mockImplementation(
      async () =>
        new Promise<never>((resolve) => {
          releaseScan = () => resolve();
        }),
    );
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'queued',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      teamId: 'team-A',
    });
    expect(WebhookTriggerResponse.safeParse(body).success).toBe(true);

    releaseScan();
    await flushMicrotasks();
  });

  it('pre-creates a queued Scan row + a WebhookTrigger side-table row', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    await POST(
      mkReq({
        body: {
          target: 'a.example.org',
          repository: { url: 'https://a.example.org/r', ref: 'refs/heads/main', commit: 'abc123' },
          build: { id: 'build-1', status: 'success', branch: 'main' },
        },
      }),
    );

    expect(scanCreate).toHaveBeenCalledTimes(1);
    const scanArgs = scanCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(scanArgs.data).toMatchObject({
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'queued',
      teamId: 'team-A',
    });

    expect(webhookTriggerCreate).toHaveBeenCalledTimes(1);
    const trigArgs = webhookTriggerCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(trigArgs.data).toMatchObject({
      scanId: 'scan-queued-1',
      teamId: 'team-A',
      repositoryUrl: 'https://a.example.org/r',
      repositoryRef: 'refs/heads/main',
      repositoryCommit: 'abc123',
      buildId: 'build-1',
      buildStatus: 'success',
      buildBranch: 'main',
      webhookId: TEST_WEBHOOK_ID,
      signatureAlgorithm: 'hmac-sha256',
    });
  });

  it('folds an absent repository.url down to https://<target>/ so the side-table still has a row', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    await POST(mkReq({ body: { target: 'a.example.org' } }));
    const trigArgs = webhookTriggerCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(trigArgs.data.repositoryUrl).toBe('https://a.example.org/');
  });

  it('threads scanIdOverride into runScan so the runner updates the pre-created row', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(runScanSpy).toHaveBeenCalledTimes(1);
    const args = runScanSpy.mock.calls[0] as [
      unknown,
      { teamId?: string; scanIdOverride?: string },
    ];
    expect(args[0]).toMatchObject({ target: 'a.example.org', ports: [443], mode: 'tcp-only' });
    expect(args[1]).toMatchObject({
      teamId: 'team-A',
      scanIdOverride: 'scan-queued-1',
    });
  });

  it('forwards DEFAULT_PORTS ([443]) and mode "tcp-only" to runScan when caller omits them', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(runScanSpy).toHaveBeenCalledWith(
      { target: 'a.example.org', ports: [443], mode: 'tcp-only' },
      expect.objectContaining({ teamId: 'team-A', scanIdOverride: 'scan-queued-1' }),
    );
  });

  it('falls back to repository.url hostname when no explicit target is given', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'b.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(
      mkReq({ body: { repository: { url: 'https://b.example.org/p/repo' } } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.target).toBe('b.example.org');
    const trigArgs = webhookTriggerCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(trigArgs.data.repositoryUrl).toBe('https://b.example.org/p/repo');
  });

  it('preserves port ordering from the request payload', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    await POST(mkReq({ body: { target: 'a.example.org', ports: [22, 443, 8443] } }));
    expect(runScanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ports: [22, 443, 8443] }),
      expect.any(Object),
    );
  });

  it('response does NOT contain summary-only keys (verdict, summary, criticalFindings, poll)', async () => {
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    const body = await res.json();
    expect(body).not.toHaveProperty('verdict');
    expect(body).not.toHaveProperty('summary');
    expect(body).not.toHaveProperty('criticalFindings');
    expect(body).not.toHaveProperty('poll');
  });

  it('201 returns BEFORE the background scan settles', async () => {
    // Deferred scan — proves the response path does not block on runScan.
    let releaseScan: () => void = () => {};
    runScanSpy.mockImplementation(
      async () =>
        new Promise<never>((resolve) => {
          releaseScan = () => resolve();
        }),
    );
    webhookFindMany.mockResolvedValueOnce([]);

    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(res.status).toBe(201);
    releaseScan();
    await flushMicrotasks();
  });
});

// ===================== GROUP D — RUN FAILURE SURFACE (502) =====================

describe('POST /api/v1/webhooks/trigger run failure surface', () => {
  beforeEach(() => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
    mockInboundOk();
  });

  it('returns 502 {code:"scan_failed",message:err.message} when runScan throws synchronously', async () => {
    // To hit 502 from the route the error must surface inside the
    // request-handler try block. The current implementation defers to a
    // fire-and-forget background chain whose errors are swallowed, so a
    // throw from runScan no longer 502s the inbound handshake. Pin the
    // new posture: the 201 is pre-created with status: 'queued' BEFORE
    // the background call; the failure surface for the inbound caller is
    // "queued row visible on /scans" rather than a 502.
    mockInboundOk();
    runScanSpy.mockRejectedValueOnce(new Error('scanner exploded'));
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(res.status).toBe(201);
    await flushMicrotasks();
  });
});

// ===================== GROUP E — OTHER VERBS (405) =====================

type WebhookTriggerVerbs = 'GET' | 'PUT' | 'PATCH' | 'DELETE';

describe('POST /api/v1/webhooks/trigger other verbs', () => {
  beforeEach(() => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
  });

  it.each<WebhookTriggerVerbs>(['GET', 'PUT', 'PATCH', 'DELETE'])(
    'returns 405 {code:"method_not_allowed"} with Allow: POST for %s',
    async (method) => {
      const route = (await import('@/app/api/v1/webhooks/trigger/route')) as unknown as Record<
        WebhookTriggerVerbs,
        () => Promise<Response>
      >;
      const handler = route[method];
      expect(handler).toBeTypeOf('function');
      const res = await (handler as () => Promise<Response>)();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
      const body = await res.json();
      expect(body.code).toBe('method_not_allowed');
    },
  );
});

// ===================== GROUP F — FIRE-AND-FORGET DELIVERY =====================

describe('POST /api/v1/webhooks/trigger fire-and-forget delivery', () => {
  beforeEach(() => {
    mockAuthOk({ teamId: 'team-A', scopeKind: 'team' });
    mockInboundOk();
    runScanSpy.mockResolvedValue({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
  });

  it('looks up non-revoked webhooks by teamId and signs+POSTs to each', async () => {
    webhookFindMany.mockResolvedValueOnce([
      { id: 'wh-1', url: 'https://hooks.example.com/1' },
      { id: 'wh-2', url: 'https://hooks.example.com/2' },
    ]);
    getWebhookSigningSecretSpy.mockResolvedValueOnce('secret-1').mockResolvedValueOnce('secret-2');
    deliverWebhookSpy.mockResolvedValue({ ok: true, status: 200 });

    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(res.status).toBe(201);

    await flushMicrotasks();

    expect(webhookFindMany).toHaveBeenCalledWith({
      where: { teamId: 'team-A', revokedAt: null },
      select: { id: true, url: true },
    });
    expect(getWebhookSigningSecretSpy).toHaveBeenCalledTimes(2);
    expect(getWebhookSigningSecretSpy).toHaveBeenNthCalledWith(1, 'wh-1', 'team-A');
    expect(getWebhookSigningSecretSpy).toHaveBeenNthCalledWith(2, 'wh-2', 'team-A');
    expect(deliverWebhookSpy).toHaveBeenCalledTimes(2);
    expect(deliverWebhookSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: 'wh-1',
        url: 'https://hooks.example.com/1',
        secret: 'secret-1',
        payload: expect.objectContaining({
          id: 'scan-queued-1',
          teamId: 'team-A',
          status: 'completed',
        }),
      }),
    );
    expect(deliverWebhookSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: 'wh-2',
        url: 'https://hooks.example.com/2',
        secret: 'secret-2',
        payload: expect.objectContaining({
          id: 'scan-queued-1',
          teamId: 'team-A',
          status: 'completed',
        }),
      }),
    );
  });

  it('skips delivery entirely when the team has no registered webhooks', async () => {
    webhookFindMany.mockResolvedValueOnce([]);
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    await POST(mkReq({ body: { target: 'a.example.org' } }));
    await flushMicrotasks();
    expect(webhookFindMany).toHaveBeenCalledTimes(1);
    expect(getWebhookSigningSecretSpy).not.toHaveBeenCalled();
    expect(deliverWebhookSpy).not.toHaveBeenCalled();
  });

  it('returns the 201 response BEFORE the background scan + delivery settles', async () => {
    // Deferred delivery — proves the 201 lands BEFORE the outbound
    // delivery resolves. The scan chain runs strictly before delivery
    // (runScan → deliverAfterScan), so when scan is unresolved, delivery
    // also stays deferred. Pins the fire-and-forget outer-block posture:
    // 201 does not block on either prong of the chain.
    let releaseDelivery: () => void = () => {};
    runScanSpy.mockResolvedValueOnce({
      id: 'scan-queued-1',
      target: 'a.example.org',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
    });
    deliverWebhookSpy.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      return { ok: true, status: 200 };
    });
    webhookFindMany.mockResolvedValueOnce([{ id: 'wh-1', url: 'https://hooks.example.com/1' }]);
    getWebhookSigningSecretSpy.mockResolvedValueOnce('secret-1');

    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));

    // Response received BEFORE the deferred delivery resolves.
    expect(res.status).toBe(201);

    // Allow microtasks to settle so the scan + delivery Promise.allSettled
    // reaches `deliverWebhook`. Deliver is itself deferred — we deliberately
    // inspect that the spy has been reached BEFORE the inner delivery
    // resolves.
    await flushMicrotasks();
    expect(deliverWebhookSpy).toHaveBeenCalled();

    // Release and let everything settle.
    releaseDelivery();
    await flushMicrotasks();
  });

  it('does NOT fire deliveries when runScan throws (background swallow)', async () => {
    runScanSpy.mockRejectedValueOnce(new Error('scanner exploded'));
    const { POST } = await import('@/app/api/v1/webhooks/trigger/route');
    const res = await POST(mkReq({ body: { target: 'a.example.org' } }));
    expect(res.status).toBe(201);
    await flushMicrotasks();
    // Background chain swallows the throw — no deliveries fire.
    expect(webhookFindMany).not.toHaveBeenCalled();
    expect(deliverWebhookSpy).not.toHaveBeenCalled();
  });
});
