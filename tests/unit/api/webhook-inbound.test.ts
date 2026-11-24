// @vitest-environment node
// Unit tests for src/lib/business/webhooks-inbound.ts — pin-by-id HMAC
// verification. Covers the failure-mode matrix:
//   - missing row (no Webhook at id+teamId)
//   - foreign-team row (defense: returned as missing)
//   - revoked row
//   - wrong-algorithm row (only hmac-sha256 is supported today)
//   - decrypt-fail (env-held key differs from the one that wrote the row)
//   - missing / malformed signature header
//   - wrong signature
//   - right signature → returns the row

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// Stable env-held master key for envelope encryption so the test plaintext
// round-trips cleanly through encrypt/decrypt without depending on the
// process env.
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    WEBHOOK_SIGNING_KEY: 'a'.repeat(64),
  },
}));

const webhookFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    webhook: { findFirst: webhookFindFirst },
  },
}));

beforeEach(() => {
  webhookFindFirst.mockReset();
});

async function load() {
  const [
    { generateSigningSecret, signPayload, formatSignatureHeader, encryptSigningSecret },
    inbound,
  ] = await Promise.all([
    import('@/lib/business/webhooks'),
    import('@/lib/business/webhooks-inbound'),
  ]);
  return {
    generateSigningSecret,
    signPayload,
    formatSignatureHeader,
    encryptSigningSecret,
    inbound,
  };
}

describe('verifyInboundWebhook — happy path', () => {
  it('returns the webhook row (cipher stripped) when HMAC matches', async () => {
    const {
      generateSigningSecret,
      signPayload,
      formatSignatureHeader,
      encryptSigningSecret,
      inbound,
    } = await load();
    const secret = generateSigningSecret();
    const body = '{"target":"a.example.org"}';
    const sig = signPayload(secret, body);
    const ciphertext = encryptSigningSecret(secret);
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
      signingSecretCipher: ciphertext,
    });

    const got = await inbound.verifyInboundWebhook({
      rawBody: body,
      signatureHeader: formatSignatureHeader(sig),
      webhookId: 'wh-1',
      teamId: 'team-A',
    });

    expect(got).not.toBeNull();
    expect(got?.webhook.id).toBe('wh-1');
    expect(got?.webhook.teamId).toBe('team-A');
    expect(got?.webhook.signingAlgorithm).toBe('hmac-sha256');
    expect(got?.webhook.revokedAt).toBeNull();
    // The cipher must NEVER be returned to the caller.
    expect((got?.webhook as { signingSecretCipher?: string }).signingSecretCipher).toBeUndefined();
  });

  it('queries the prisma.webhook.findFirst with the (id, teamId, revokedAt:null) filter', async () => {
    const {
      generateSigningSecret,
      signPayload,
      formatSignatureHeader,
      encryptSigningSecret,
      inbound,
    } = await load();
    const secret = generateSigningSecret();
    const body = '{"x":1}';
    const sig = signPayload(secret, body);
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: encryptSigningSecret(secret),
    });

    await inbound.verifyInboundWebhook({
      rawBody: body,
      signatureHeader: formatSignatureHeader(sig),
      webhookId: 'wh-1',
      teamId: 'team-A',
    });

    expect(webhookFindFirst).toHaveBeenCalledTimes(1);
    expect(webhookFindFirst).toHaveBeenCalledWith({
      where: { id: 'wh-1', teamId: 'team-A', revokedAt: null },
    });
  });
});

describe('verifyInboundWebhook — failure mode matrix', () => {
  it('returns null when no row matches (id pin)', async () => {
    const { generateSigningSecret, signPayload, formatSignatureHeader, inbound } = await load();
    const secret = generateSigningSecret();
    webhookFindFirst.mockResolvedValueOnce(null);
    const got = await inbound.verifyInboundWebhook({
      rawBody: '{"x":1}',
      signatureHeader: formatSignatureHeader(signPayload(secret, '{"x":1}')),
      webhookId: 'wh-missing',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });

  it('returns null when the row belongs to a different team (foreign-team)', async () => {
    // The prisma lookup already filters by teamId, so the verifier returns
    // null without leaking cross-team existence. Pin this contract — if a
    // future refactor switches to "findFirst without teamId then compare"
    // the test catches it.
    const { generateSigningSecret, signPayload, formatSignatureHeader, inbound } = await load();
    const secret = generateSigningSecret();
    webhookFindFirst.mockResolvedValueOnce(null);
    const got = await inbound.verifyInboundWebhook({
      rawBody: '{"x":1}',
      signatureHeader: formatSignatureHeader(signPayload(secret, '{"x":1}')),
      webhookId: 'wh-foreign',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
    expect(webhookFindFirst.mock.calls[0]?.[0]).toEqual({
      where: { id: 'wh-foreign', teamId: 'team-A', revokedAt: null },
    });
  });

  it('returns null when the row is revoked', async () => {
    // The (id, teamId, revokedAt: null) filter must include `revokedAt: null`
    // so revokeWebhook flips a row without leaving a window for replay.
    const { generateSigningSecret, signPayload, formatSignatureHeader, inbound } = await load();
    const secret = generateSigningSecret();
    webhookFindFirst.mockResolvedValueOnce(null);
    await inbound.verifyInboundWebhook({
      rawBody: '{"x":1}',
      signatureHeader: formatSignatureHeader(signPayload(secret, '{"x":1}')),
      webhookId: 'wh-revoked',
      teamId: 'team-A',
    });
    const call = webhookFindFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where.revokedAt).toBeNull();
  });

  it('returns null when the stored algorithm is not hmac-sha256', async () => {
    const {
      generateSigningSecret,
      signPayload,
      formatSignatureHeader,
      encryptSigningSecret,
      inbound,
    } = await load();
    const secret = generateSigningSecret();
    const body = '{"x":1}';
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha512',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: encryptSigningSecret(secret),
    });
    const got = await inbound.verifyInboundWebhook({
      rawBody: body,
      signatureHeader: formatSignatureHeader(signPayload(secret, body)),
      webhookId: 'wh-1',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });

  it('returns null when the cipher cannot be decrypted (env key rotated)', async () => {
    const { generateSigningSecret, signPayload, formatSignatureHeader, inbound } = await load();
    const secret = generateSigningSecret();
    const body = '{"x":1}';
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: 'not-an-envelope',
    });
    const got = await inbound.verifyInboundWebhook({
      rawBody: body,
      signatureHeader: formatSignatureHeader(signPayload(secret, body)),
      webhookId: 'wh-1',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });

  it('returns null when the signature header is empty', async () => {
    const { generateSigningSecret, encryptSigningSecret, inbound } = await load();
    const secret = generateSigningSecret();
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: encryptSigningSecret(secret),
    });
    const got = await inbound.verifyInboundWebhook({
      rawBody: '{"x":1}',
      signatureHeader: '',
      webhookId: 'wh-1',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });

  it('returns null when the signature payload is tampered', async () => {
    const {
      generateSigningSecret,
      signPayload,
      formatSignatureHeader,
      encryptSigningSecret,
      inbound,
    } = await load();
    const secret = generateSigningSecret();
    const body = '{"x":1}';
    const sig = signPayload(secret, body);
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: encryptSigningSecret(secret),
    });
    const got = await inbound.verifyInboundWebhook({
      rawBody: '{"x":2}',
      signatureHeader: formatSignatureHeader(sig),
      webhookId: 'wh-1',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });

  it('returns null when the signature uses the wrong secret', async () => {
    const {
      generateSigningSecret,
      signPayload,
      formatSignatureHeader,
      encryptSigningSecret,
      inbound,
    } = await load();
    const storedSecret = generateSigningSecret();
    const otherSecret = generateSigningSecret();
    const body = '{"x":1}';
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: encryptSigningSecret(storedSecret),
    });
    const got = await inbound.verifyInboundWebhook({
      rawBody: body,
      signatureHeader: formatSignatureHeader(signPayload(otherSecret, body)),
      webhookId: 'wh-1',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });

  it('returns null when the signature fails the regex (non-hex header)', async () => {
    const { generateSigningSecret, encryptSigningSecret, inbound } = await load();
    const secret = generateSigningSecret();
    webhookFindFirst.mockResolvedValueOnce({
      id: 'wh-1',
      url: 'https://hooks.example.com/1',
      teamId: 'team-A',
      signingAlgorithm: 'hmac-sha256',
      lastSignedAt: null,
      createdAt: new Date(),
      revokedAt: null,
      signingSecretCipher: encryptSigningSecret(secret),
    });
    const got = await inbound.verifyInboundWebhook({
      rawBody: '{"x":1}',
      signatureHeader: 'sha256=not-hex-content-but-some-string-padding-padding-pad',
      webhookId: 'wh-1',
      teamId: 'team-A',
    });
    expect(got).toBeNull();
  });
});
