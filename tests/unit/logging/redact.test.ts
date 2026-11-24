// @vitest-environment jsdom
// Unit tests for the PII/secret redactor.

import { describe, expect, it } from 'vitest';
import { redactBody, redactHeaders } from '@/lib/logging/redact';

describe('redactBody', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redactBody({
      name: 'prod-ci',
      hash: 'abc123',
      nested: { token: 'tok', secret: 'shh', password: 'pw', keep: 'me' },
      array: [{ api_token: 'x', ok: 1 }],
    });
    expect(out).toEqual({
      name: 'prod-ci',
      hash: '[REDACTED]',
      nested: { token: '[REDACTED]', secret: '[REDACTED]', password: '[REDACTED]', keep: 'me' },
      array: [{ api_token: 'x', ok: 1 }],
    });
  });

  it('returns primitives unchanged', () => {
    expect(redactBody(42)).toBe(42);
    expect(redactBody('hello')).toBe('hello');
    expect(redactBody(null)).toBeNull();
    expect(redactBody(undefined)).toBeUndefined();
  });

  it('handles circular structures without recursing forever', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const out = redactBody(a) as Record<string, unknown>;
    expect(out.x).toBe(1);
    expect(out.self).toBe('[CIRCULAR]');
  });

  it('lowercases key match for case insensitivity', () => {
    const out = redactBody({ PASSWORD: 'pw' }) as Record<string, unknown>;
    expect(out.PASSWORD).toBe('[REDACTED]');
  });
});

describe('redactHeaders', () => {
  it('redacts x-api-key, authorization, cookie', () => {
    const h = new Headers({
      'x-api-key': 'plaintext-key',
      authorization: 'Bearer foo',
      cookie: 'sid=abc',
      'content-type': 'application/json',
    });
    const out = redactHeaders(h);
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.cookie).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });

  it('accepts a plain record', () => {
    const out = redactHeaders({ 'x-api-key': 'k', other: 'v' });
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out.other).toBe('v');
  });
});
