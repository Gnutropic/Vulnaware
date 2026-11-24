// @polsia:user-owned — captured-error emitter. Composes the structured
// payload (sanitized request envelope + correlation fields + stack) and
// writes it through the JSON-line sink. The default sink is stdout
// (console.error); to swap in Sentry/Datadog/Logflare later, replace the
// implementation here without touching any caller.

import 'server-only';
import type { ErrorEventEntry } from '@/lib/contracts/log';
import { emitErrorLogEvent, type RequestAuthContext } from '@/lib/logging/logger';
import { redactBody, redactHeaders } from '@/lib/logging/redact';

export interface CaptureErrorInput {
  requestId: string;
  method: string;
  path: string;
  route: string;
  request: Request;
  body: unknown;
  err: unknown;
  auth: RequestAuthContext;
}

function errorPayload(err: unknown): ErrorEventEntry['err'] {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? undefined };
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: err };
  }
  return { name: 'Error', message: 'unknown error' };
}

export function captureApiError(input: CaptureErrorInput): void {
  const headers = redactHeaders(input.request.headers);
  const body = redactBody(input.body);

  emitErrorLogEvent({
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'api.error',
    requestId: input.requestId,
    teamId: input.auth.teamId,
    userId: input.auth.userId,
    keyId: input.auth.keyId,
    scopeKind: input.auth.scopeKind,
    route: input.route,
    method: input.method,
    path: input.path,
    request: { url: input.request.url, headers, body },
    err: errorPayload(input.err),
  });
}
