// @polsia:user-owned — PII / secret redactor used before any structured log
// payload leaves the request boundary. Pure utility — no side effects, no
// imports from server-only modules, so it is unit-testable in jsdom.

const SENSITIVE_HEADER_NAMES = new Set([
  'x-api-key',
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

const SENSITIVE_BODY_KEYS = new Set(['hash', 'secret', 'password', 'token']);

const REDACTED = '[REDACTED]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function redactValue(key: string, value: unknown, seen: WeakSet<object>): unknown {
  if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
    return REDACTED;
  }
  return redactUnknown(value, seen);
}

function redactUnknown(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactUnknown(v, seen));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redactValue(k, v, seen);
  }
  return out;
}

export function redactBody(body: unknown): unknown {
  return redactUnknown(body);
}

export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[lower] = SENSITIVE_HEADER_NAMES.has(lower) ? REDACTED : value;
  }
  return out;
}
