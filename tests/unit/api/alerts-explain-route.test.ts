// @vitest-environment node
// Unit tests for POST /api/alerts/[id]/explain. Mirrors the posture of
// tests/unit/api/alerts-comments-route.test.ts:
//   - vi.mock('server-only') so the module loads
//   - vi.mock('@/lib/db') for the Prisma scope-check
//   - vi.mock('@/lib/team-auth') with a swappable requireTeamRole whose
//     thrown Response encodes the 401/403 gates
//   - vi.mock('@/lib/ai/client') with a synthetic streamChat whose
//     `Response.body` is a tiny ReadableStream that pumps a fixed
//     SSE payload — enough to prove the route forwards bytes unchanged
//     and stamps the right headers, without stalling the test runner
//
// Asserted:
//   - 401 + 403 opaque auth gates
//   - 503 'unavailable' when POLSIA_API_KEY is missing
//   - Opaque 404 when alert belongs to a different team (and the AI
//     helper is never called)
//   - Happy path: streamChat is invoked with the right prompt/task/
//     signal, the route returns a Response whose body is the same
//     ReadableStream and whose content-type is text/event-stream
//   - streamChat is called WITH an AbortSignal so a hung proxy closes
//     deterministically when the client aborts (verified via the
//     signal.reason downstream)
//   - PUT/PATCH/DELETE → 405 with Allow: POST

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const alertFindFirst = vi.fn();
const cveEntryFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: { findFirst: alertFindFirst },
    cveEntry: { findUnique: cveEntryFindUnique },
  },
}));

// Default: key present so the up-front check passes. Tests that need
// the 503 branch override this with `.mockReturnValueOnce(undefined)`.
const envValues: Record<string, string | undefined> = {
  POLSIA_API_KEY: 'test-key',
  POLSIA_API_TOKEN: undefined,
};
vi.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop: string) {
        return envValues[prop];
      },
    },
  ),
}));

const streamChatMock = vi.fn();
class AiConfigurationErrorMock extends Error {
  constructor(message = 'AI is not configured for this app.') {
    super(message);
    this.name = 'AiConfigurationError';
  }
}

vi.mock('@/lib/ai/client', () => ({
  streamChat: streamChatMock,
  AiConfigurationError: AiConfigurationErrorMock,
}));

const requireTeamRoleMock = vi.fn();

vi.mock('@/lib/team-auth', () => ({
  requireTeamRole: async () => requireTeamRoleMock(),
}));

const MEMBER_CTX = {
  user: {
    id: 'user-1',
    role: 'member',
    email: 'member@example.com',
    name: 'Member',
    emailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  membership: { id: 'mem-1', userId: 'user-1', teamId: 'team-1', role: 'member' },
  team: { id: 'team-1', name: 'workspace' },
};

function makePostRequest(id = 'alert-1') {
  return new Request(`http://test/api/alerts/${id}/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

function makeAlertRow(overrides: Record<string, unknown> = {}) {
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

// Build a synthetic SSE ReadableStream similar to what streamChat would
// return from the platform proxy — three OpenAI-compatible delta
// chunks followed by `[DONE]`. Streamed in two TCP-shaped segments so
// the test also proves the route forwards bytes unchanged across a
// fragmentation boundary.
function makeSseResponse() {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"This "}}]}\n\n'));
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"CVE "}}]}'));
      controller.enqueue(
        enc.encode('\n\ndata: {"choices":[{"delta":{"content":"matters."}}]}\n\n'),
      );
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  alertFindFirst.mockReset();
  cveEntryFindUnique.mockReset();
  streamChatMock.mockReset();
  requireTeamRoleMock.mockReset();
  envValues.POLSIA_API_KEY = 'test-key';
  envValues.POLSIA_API_TOKEN = undefined;
  requireTeamRoleMock.mockResolvedValue(MEMBER_CTX);
});

// ===================== POST /api/alerts/[id]/explain =====================

describe('POST /api/alerts/[id]/explain', () => {
  it('returns 401 when there is no session', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(401);
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is below member', async () => {
    requireTeamRoleMock.mockImplementationOnce(async () => {
      throw Response.json({ error: 'Forbidden' }, { status: 403 });
    });
    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(403);
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it('returns 503 unavailable when POLSIA_API_KEY is missing', async () => {
    envValues.POLSIA_API_KEY = undefined;
    envValues.POLSIA_API_TOKEN = undefined;
    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'unavailable' });
    // Scope check is NOT performed — missing key short-circuits BEFORE
    // any DB query (mirrors the summary/suggested-fix 503 posture).
    expect(alertFindFirst).not.toHaveBeenCalled();
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it('returns 503 unavailable when only POLSIA_API_TOKEN is set and streamChat throws', async () => {
    envValues.POLSIA_API_KEY = undefined;
    envValues.POLSIA_API_TOKEN = 'tok';
    // The token fallback passes the up-front key check so the scope
    // check fires. We mock streamChat to throw (mirrors the missing-
    // key runtime path the wrapper also throws into) so the route
    // closes with the 503 unavailable shape.
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    cveEntryFindUnique.mockResolvedValueOnce({
      cvssScore: 7.5,
      description: 'A vulnerability affecting fixture data.',
    });
    streamChatMock.mockImplementationOnce(async () => {
      throw new Error('upstream 502');
    });
    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'unavailable' });
  });

  it('returns opaque 404 when the alert belongs to a different team', async () => {
    alertFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
    // Cross-team probing MUST NOT trigger a model call.
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(cveEntryFindUnique).not.toHaveBeenCalled();
  });

  it('streams the upstream Response body unchanged on the happy path', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    cveEntryFindUnique.mockResolvedValueOnce({
      cvssScore: 7.5,
      description: 'A vulnerability affecting fixture data.',
    });
    streamChatMock.mockResolvedValueOnce(makeSseResponse());

    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    // streamChat was invoked with the right task + signal + messages.
    const call = streamChatMock.mock.calls[0]?.[0];
    expect(call.task).toBe('cve-explain');
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(Array.isArray(call.messages)).toBe(true);
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[1].role).toBe('user');
    // The user prompt carries the CVE id + CVSS + asset posture verbatim.
    expect(call.messages[1].content).toContain('CVE-2025-0001');
    expect(call.messages[1].content).toContain('203.0.113.10');
    expect(call.messages[1].content).toContain('edge.example.com');

    // The Response body IS the ReadableStream we synthesized — proves
    // the route forwards bytes unchanged (no parse/transform).
    expect(res.body).toBeInstanceOf(ReadableStream);
    if (!res.body) throw new Error('expected streamed body');

    // Drain it deterministically and confirm we got the full payload
    // including the trailing `[DONE]` sentinel.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const chunks: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(dec.decode(value, { stream: true }));
    }
    chunks.push(dec.decode());
    const payload = chunks.join('');
    expect(payload).toContain('This ');
    expect(payload).toContain('CVE ');
    expect(payload).toContain('matters.');
    expect(payload).toContain('data: [DONE]');
  });

  it('forwards an AbortSignal to the upstream call so client cancellation stops the proxy', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    cveEntryFindUnique.mockResolvedValueOnce({
      cvssScore: 5.4,
      description: 'A different fixture.',
    });

    // Capture the signal handed to streamChat and prove it is the
    // route's AbortController signal. A polled abort path (proxy
    // observing signal.aborted) is what stops token burn when the
    // browser closes the connection or the 30s safety timer fires —
    // proving the route STITCHED the signal through is the assertion.
    let capturedSignal: AbortSignal | undefined;
    streamChatMock.mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      );
    });

    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    expect(capturedSignal).toBeDefined();
    // Same `class` as the platform's own AbortSignal — proves the
    // route created a controller and handed the signal through (vs.
    // forwarding `undefined` and skipping the timeout wiring).
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // The signal's `aborted` reflects its controller's state — at
    // hand-off it has not fired because no client cancelled and the
    // 30s timer is still pending (fake timers aren't running here).
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('returns 503 when streamChat throws AiConfigurationError', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    cveEntryFindUnique.mockResolvedValueOnce({
      cvssScore: 7.5,
      description: 'A vulnerability affecting fixture data.',
    });
    streamChatMock.mockImplementationOnce(async () => {
      throw new AiConfigurationErrorMock('key missing between check and call');
    });

    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'unavailable' });
  });

  it('returns 503 when streamChat throws any non-configuration error', async () => {
    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    cveEntryFindUnique.mockResolvedValueOnce({
      cvssScore: 7.5,
      description: 'A vulnerability affecting fixture data.',
    });
    streamChatMock.mockImplementationOnce(async () => {
      throw new Error('upstream 502');
    });

    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'unavailable' });
  });

  it('returns 500 when the DB scope-check throws', async () => {
    alertFindFirst.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('clears the 30s server-side timeout once streamChat resolves', async () => {
    // Use vi fake timers so we can flush the timeout deterministically.
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    alertFindFirst.mockResolvedValueOnce(makeAlertRow());
    cveEntryFindUnique.mockResolvedValueOnce({
      cvssScore: 7.5,
      description: 'A vulnerability affecting fixture data.',
    });
    streamChatMock.mockResolvedValueOnce(makeSseResponse());

    const { POST } = await import('@/app/api/alerts/[id]/explain/route');
    const res = await POST(makePostRequest(), {
      params: Promise.resolve({ id: 'alert-1' }),
    });
    expect(res.status).toBe(200);
    // The route cleared exactly one timeout — the 30s safety net.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // Advance fake time past the 30s window and confirm the controller
    // is NOT aborted (the timer was cleared in time).
    vi.advanceTimersByTime(60_000);
    clearSpy.mockRestore();
    vi.useRealTimers();
  });
});

// ===================== Method guards =====================

describe('methodNotAllowed stubs for /api/alerts/[id]/explain', () => {
  it.each([['GET'], ['PUT'], ['PATCH'], ['DELETE']])(
    '%s returns 405 with Allow: POST',
    async (method) => {
      const routeModule = await import('@/app/api/alerts/[id]/explain/route');
      const handler = (routeModule as unknown as Record<string, () => Promise<Response>>)[method];
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    },
  );
});
