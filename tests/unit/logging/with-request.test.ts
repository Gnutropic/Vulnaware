// @vitest-environment node
// Unit tests for the withApiRequest wrapper.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  consoleLog.mockClear();
  consoleError.mockClear();
});

function makeReq(opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const init: RequestInit = { method: opts.method ?? 'GET', headers: opts.headers ?? {} };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return new Request('http://test/api/v1/scans', init);
}

describe('withApiRequest', () => {
  it('mints a request id and sets X-Request-ID on the response', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(makeReq({}), async () => new Response('ok', { status: 200 }));
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes inbound X-Request-ID when well-formed', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(
      makeReq({ headers: { 'x-request-id': 'my-trace-id' } }),
      async () => new Response('ok', { status: 200 }),
    );
    expect(res.headers.get('x-request-id')).toBe('my-trace-id');
  });

  it('mints a new id when the inbound id is malformed', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(
      makeReq({ headers: { 'x-request-id': 'has spaces inside' } }),
      async () => new Response('ok', { status: 200 }),
    );
    expect(res.headers.get('x-request-id')).not.toBe('has spaces inside');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the handler response unchanged on 200', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const inner = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await withApiRequest(makeReq({}), async () => inner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('captures a thrown error and returns a 500', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(makeReq({}), async () => {
      throw new Error('boom');
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    // Captured error event + structured request log both emitted.
    expect(consoleError).toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalled();
    const errorLine = JSON.parse(consoleError.mock.calls.at(-1)?.[0] as string);
    expect(errorLine.msg).toBe('api.error');
    expect(errorLine.err.message).toBe('boom');
    expect(errorLine.request.url).toBe('http://test/api/v1/scans');
  });

  it('passes through thrown Responses (e.g. requireAuth-thrown 401)', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(makeReq({}), async () => {
      throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('captures auth context set via setRequestAuth in the log', async () => {
    const { withApiRequest, setRequestAuth } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(makeReq({}), async () => {
      await Promise.resolve();
      setRequestAuth({ userId: 'user-42', teamId: 'team-A' });
      return new Response(null, { status: 200 });
    });
    expect(res.status).toBe(200);
    const routeLogLine = JSON.parse(consoleLog.mock.calls.at(-1)?.[0] as string);
    expect(routeLogLine.userId).toBe('user-42');
    expect(routeLogLine.teamId).toBe('team-A');
  });

  it('redacts sensitive headers and body fields in captured events', async () => {
    const { withApiRequest } = await import('@/lib/logging/with-request');
    const res = await withApiRequest(
      makeReq({
        method: 'POST',
        headers: { 'x-api-key': 'plaintext-key', authorization: 'Bearer foo' },
        body: { token: 'shh', password: 'pw', name: 'keep' },
      }),
      async () => {
        throw new Error('thrown');
      },
    );
    expect(res.status).toBe(500);
    const errorLine = JSON.parse(consoleError.mock.calls.at(-1)?.[0] as string);
    expect(errorLine.request.headers['x-api-key']).toBe('[REDACTED]');
    expect(errorLine.request.headers.authorization).toBe('[REDACTED]');
    expect(errorLine.request.body).toEqual({
      token: '[REDACTED]',
      password: '[REDACTED]',
      name: 'keep',
    });
  });
});
