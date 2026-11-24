// @vitest-environment node
// Unit tests for src/lib/business/webhooks.ts — sign/verify round-trip,
// envelope-encryption round-trip, header-format tolerance, and the
// integration shape of deliverWebhook (outbound fetch + headers).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// Mock @/lib/env so the business module doesn't need to import the t3-env
// schema (which would require SKIP_ENV_VALIDATION in the test process).
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    WEBHOOK_SIGNING_KEY: 'a'.repeat(64),
  },
}));

// ===================== SIGN / VERIFY ROUND-TRIP =====================

describe('signPayload + verifySignature', () => {
  it('round-trips a valid signature', async () => {
    const { generateSigningSecret, signPayload, verifySignature, formatSignatureHeader } =
      await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    const body = JSON.stringify({ scanId: 'scan-1', status: 'completed' });
    const sig = signPayload(secret, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(secret, body, formatSignatureHeader(sig))).toBe(true);
  });

  it('returns false on a tampered body', async () => {
    const { generateSigningSecret, signPayload, verifySignature, formatSignatureHeader } =
      await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    const sig = signPayload(secret, '{"a":1}');
    expect(verifySignature(secret, '{"a":2}', formatSignatureHeader(sig))).toBe(false);
  });

  it('returns false on a single-byte body modification', async () => {
    const { generateSigningSecret, signPayload, verifySignature, formatSignatureHeader } =
      await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    const body = JSON.stringify({ scanId: 'scan-1', status: 'completed' });
    const sig = signPayload(secret, body);
    const tampered = `${body}x`;
    expect(verifySignature(secret, tampered, formatSignatureHeader(sig))).toBe(false);
  });

  it('returns false with the wrong secret', async () => {
    const { generateSigningSecret, signPayload, verifySignature, formatSignatureHeader } =
      await import('@/lib/business/webhooks');
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    const body = '{"x":1}';
    const sig = signPayload(a, body);
    expect(verifySignature(b, body, formatSignatureHeader(sig))).toBe(false);
  });
});

// ===================== HEADER FORMAT =====================

describe('verifySignature header format tolerance', () => {
  it('accepts sha256=<64-hex>', async () => {
    const { generateSigningSecret, signPayload, verifySignature } = await import(
      '@/lib/business/webhooks'
    );
    const secret = generateSigningSecret();
    const sig = signPayload(secret, 'body');
    expect(verifySignature(secret, 'body', `sha256=${sig}`)).toBe(true);
  });

  it('rejects a too-short hex value', async () => {
    const { generateSigningSecret, verifySignature } = await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    expect(verifySignature(secret, 'body', `sha256=${'a'.repeat(63)}`)).toBe(false);
  });

  it('rejects a too-long hex value', async () => {
    const { generateSigningSecret, verifySignature } = await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    expect(verifySignature(secret, 'body', `sha256=${'a'.repeat(65)}`)).toBe(false);
  });

  it('rejects a missing prefix', async () => {
    const { generateSigningSecret, signPayload, verifySignature } = await import(
      '@/lib/business/webhooks'
    );
    const secret = generateSigningSecret();
    const sig = signPayload(secret, 'body');
    expect(verifySignature(secret, 'body', sig)).toBe(false);
  });

  it('rejects a wrong-algorithm prefix', async () => {
    const { generateSigningSecret, signPayload, verifySignature } = await import(
      '@/lib/business/webhooks'
    );
    const secret = generateSigningSecret();
    const sig = signPayload(secret, 'body');
    expect(verifySignature(secret, 'body', `sha1=${sig}`)).toBe(false);
  });

  it('rejects non-hex characters', async () => {
    const { generateSigningSecret, verifySignature } = await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    // 64 chars but contains non-hex 'g'
    expect(verifySignature(secret, 'body', `sha256=${'g'.repeat(64)}`)).toBe(false);
  });

  it('rejects an empty header', async () => {
    const { generateSigningSecret, verifySignature } = await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    expect(verifySignature(secret, 'body', '')).toBe(false);
  });

  it('never throws on length-mismatched input (constant-time safety)', async () => {
    const { generateSigningSecret, verifySignature } = await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    // Lengths are filtered by the regex, but force a non-regex-passing input
    // through the constant-time path: signature buffer length 64 vs empty
    // payload buffer would never be equal — but `verifySignature` short-
    // circuits on the regex check first. This test pins that posture.
    expect(verifySignature(secret, 'body', `sha256=${'0'.repeat(32)}`)).toBe(false);
  });
});

// ===================== SECRET FORMAT =====================

describe('generateSigningSecret', () => {
  it('produces 64 lower-case hex characters', async () => {
    const { generateSigningSecret } = await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a unique secret per call', async () => {
    const { generateSigningSecret } = await import('@/lib/business/webhooks');
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).not.toBe(b);
  });
});

// ===================== ENVELOPE ENCRYPTION ROUND-TRIP =====================

describe('envelope encryption', () => {
  it('encrypts and decrypts back to the original plaintext', async () => {
    const { encryptSigningSecret, decryptSigningSecret } = await import('@/lib/business/webhooks');
    const plaintext = 'a'.repeat(64);
    const stored = encryptSigningSecret(plaintext);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(decryptSigningSecret(stored)).toBe(plaintext);
  });

  it('returns null on a malformed ciphertext', async () => {
    const { decryptSigningSecret } = await import('@/lib/business/webhooks');
    expect(decryptSigningSecret('not-an-envelope')).toBeNull();
    expect(decryptSigningSecret('enc:v1:only:four:parts:more:than:five')).toBeNull();
  });

  it('returns null when the GCM tag does not verify (tampered ciphertext)', async () => {
    const { encryptSigningSecret, decryptSigningSecret } = await import('@/lib/business/webhooks');
    const stored = encryptSigningSecret('secret');
    // Flip a bit in the ciphertext (5th segment, base64-encoded).
    const parts = stored.split(':');
    const ct = parts[3] ?? '';
    const flipped = ct[0] === 'A' ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    parts[3] = flipped;
    expect(decryptSigningSecret(parts.join(':'))).toBeNull();
  });
});

// ===================== OUTBOUND DELIVERY HEADER SHAPE =====================

describe('deliverWebhook header shape', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends X-VulnAware-Signature: sha256=<hex> on outbound POSTs', async () => {
    const { generateSigningSecret, signPayload, formatSignatureHeader, deliverWebhook } =
      await import('@/lib/business/webhooks');
    const secret = generateSigningSecret();
    const payload = { id: 'scan-1', status: 'completed' };
    const body = JSON.stringify(payload);
    await deliverWebhook({
      webhookId: 'wh-1',
      url: 'https://hooks.example.com/v',
      secret,
      payload,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://hooks.example.com/v');
    expect(calledInit.method).toBe('POST');
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-vulnaware-signature']).toBe(formatSignatureHeader(signPayload(secret, body)));
    expect(headers['x-vulnaware-delivery']).toMatch(/^[0-9a-f]{16}$/);
    expect(calledInit.body).toBe(body);
  });

  it('returns ok=true on a 2xx response', async () => {
    const { generateSigningSecret, deliverWebhook } = await import('@/lib/business/webhooks');
    const res = await deliverWebhook({
      webhookId: 'wh-1',
      url: 'https://hooks.example.com/v',
      secret: generateSigningSecret(),
      payload: { x: 1 },
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns ok=false on a non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const { generateSigningSecret, deliverWebhook } = await import('@/lib/business/webhooks');
    const res = await deliverWebhook({
      webhookId: 'wh-1',
      url: 'https://hooks.example.com/v',
      secret: generateSigningSecret(),
      payload: { x: 1 },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it('catches network errors and never throws', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { generateSigningSecret, deliverWebhook } = await import('@/lib/business/webhooks');
    const res = await deliverWebhook({
      webhookId: 'wh-1',
      url: 'https://hooks.example.com/v',
      secret: generateSigningSecret(),
      payload: { x: 1 },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ECONNREFUSED');
    expect(res.status).toBeNull();
  });
});

// ===================== CONSTANT-TIME COMPARE =====================

describe('constantTimeEqualHex', () => {
  it('returns true for equal hex strings', async () => {
    const { constantTimeEqualHex } = await import('@/lib/business/webhooks');
    expect(constantTimeEqualHex('abc', 'abc')).toBe(true);
  });

  it('returns false for differing hex strings of the same length', async () => {
    const { constantTimeEqualHex } = await import('@/lib/business/webhooks');
    expect(constantTimeEqualHex('abc', 'abd')).toBe(false);
  });

  it('returns false for length-mismatched strings without throwing', async () => {
    const { constantTimeEqualHex } = await import('@/lib/business/webhooks');
    expect(constantTimeEqualHex('abc', 'abcd')).toBe(false);
  });
});
