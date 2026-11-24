// @polsia:user-owned — `withApiRequest(req, handler)` sets the ALS context,
// mints/echoes X-Request-ID, captures latency, runs the handler inside
// `AsyncLocalStorage.run`, emits the success log, catches throws into a
// captured error event AND returns the handler's existing mapped Response.
//
// Contract:
//   - The handler is a `() => Promise<Response>`. Auth happens inside the
//     handler — the wrapper does NOT add a gate, it observes the final
//     Response and logs its status code.
//   - Thrown errors (including thrown Responses, which are uncommon but
//     handled by some upstream helpers) are caught: a captured event is
//     emitted, then the wrapper maps the throw into a sane 500 if the
//     throw is not itself a Response. If the throw IS a Response (e.g.
//     requireAuth's thrown 401), that Response is returned unchanged.

import 'server-only';
import { captureApiError } from '@/lib/logging/error-tracking';
import {
  getRequestLogger,
  logRequest,
  normalizeInboundRequestId,
  type RequestAuthContext,
  type RequestContext,
  runWithRequestContext,
  setRequestAuth,
} from '@/lib/logging/logger';

const HEADER_NAME = 'x-request-id';

function describeRoute(req: Request): { route: string; path: string; method: string } {
  const url = new URL(req.url);
  const path = url.pathname;
  return {
    route: `${req.method} ${path}`,
    path,
    method: req.method,
  };
}

const EMPTY_AUTH: RequestAuthContext = {
  userId: null,
  teamId: null,
  keyId: null,
  scopeKind: null,
};

async function readJsonBody(req: Request, method: string): Promise<unknown> {
  if (method === 'GET' || method === 'HEAD') return null;
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return null;
  try {
    return await req.clone().json();
  } catch {
    return null;
  }
}

export async function withApiRequest(
  req: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const inboundId = req.headers.get(HEADER_NAME);
  const requestId = normalizeInboundRequestId(inboundId);
  const { route, path, method } = describeRoute(req);

  const ctx: RequestContext = {
    requestId,
    method,
    path,
    route,
    auth: { userId: null, teamId: null, keyId: null, scopeKind: null },
    startedAt: Date.now(),
  };

  return runWithRequestContext(ctx, async () => {
    const startedAt = Date.now();
    let response: Response;
    let capturedBody: unknown = null;
    let innerAuth = EMPTY_AUTH;

    try {
      capturedBody = await readJsonBody(req, method);
      response = await handler();
      innerAuth = getRequestLogger()?.auth ?? EMPTY_AUTH;
    } catch (thrown) {
      const latencyMs = Date.now() - startedAt;
      const authSnapshot = getRequestLogger()?.auth ?? EMPTY_AUTH;

      if (thrown instanceof Response) {
        // Upstream helper (e.g. requireAuth) chose to throw a Response.
        // Emit a captured event when status >= 500 (true upstream failure)
        // and return the upstream Response unchanged otherwise.
        if (thrown.status >= 500) {
          captureApiError({
            requestId,
            method,
            path,
            route,
            request: req,
            body: capturedBody,
            err: thrown,
            auth: authSnapshot,
          });
        }
        logRequest({
          requestId,
          method,
          path,
          route,
          statusCode: thrown.status,
          latencyMs,
          auth: authSnapshot,
          err:
            thrown.status >= 500
              ? {
                  name: 'Response',
                  message: `${thrown.status} ${thrown.statusText}`,
                }
              : null,
        });
        const withHeader = new Response(thrown.body, {
          status: thrown.status,
          statusText: thrown.statusText,
          headers: thrown.headers,
        });
        withHeader.headers.set(HEADER_NAME, requestId);
        return withHeader;
      }

      captureApiError({
        requestId,
        method,
        path,
        route,
        request: req,
        body: capturedBody,
        err: thrown,
        auth: authSnapshot,
      });
      logRequest({
        requestId,
        method,
        path,
        route,
        statusCode: 500,
        latencyMs,
        auth: authSnapshot,
        err:
          thrown instanceof Error
            ? { name: thrown.name, message: thrown.message, stack: thrown.stack ?? undefined }
            : { name: 'Error', message: typeof thrown === 'string' ? thrown : 'unknown error' },
      });
      const fallback = new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
      fallback.headers.set(HEADER_NAME, requestId);
      return fallback;
    }

    const latencyMs = Date.now() - startedAt;
    logRequest({
      requestId,
      method,
      path,
      route,
      statusCode: response.status,
      latencyMs,
      auth: innerAuth,
      err: null,
    });

    response.headers.set(HEADER_NAME, requestId);
    return response;
  });
}

export { setRequestAuth };
