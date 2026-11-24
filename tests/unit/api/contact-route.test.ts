// @vitest-environment node
// Unit tests for POST /api/contact. Module-installed route; this file
// only validates the route's branches the brief calls out — validation
// 400 flat-map, honeypot silent 200, happy-path send to owner inbox.
//
// Mirrors tests/unit/api/alerts-comments-route.test.ts posture:
//   - vi.mock('server-only') so the route's `import 'server-only'`
//     collapses under vitest.
//   - vi.mock('@/lib/email/send') for a swappable sendEmail whose call
//     args drive the happy-path assertions.
//   - vi.mock('@/lib/env') for POLSIA_EMAIL_PROXY_URL (env is read at
//     module-load time, the mock must be in place before
//     `vi.resetModules()` + dynamic import of the route per test).
//   - vi.resetModules() in beforeEach so each test imports a fresh
//     route module and picks up `process.env.POLSIA_COMPANY_EMAIL`
//     against the test-owned recipient.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const sendEmailMock = vi.fn();
vi.mock('@/lib/email/send', () => ({ sendEmail: sendEmailMock }));

vi.mock('@/lib/env', () => ({
  env: { POLSIA_EMAIL_PROXY_URL: 'http://proxy.test/send' },
}));

const RECIPIENT = 'owner@example.com';

function makePostRequest(body: unknown) {
  return new Request('http://test/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sendEmailMock.mockReset();
  process.env.POLSIA_COMPANY_EMAIL = RECIPIENT;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.POLSIA_COMPANY_EMAIL;
});

describe('POST /api/contact', () => {
  it('returns 400 flat-map when name/email/message are invalid and does not send', async () => {
    const { POST } = await import('@/app/api/contact/route');
    const res = await POST(makePostRequest({ name: '', email: 'not-an-email', message: '' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Record<string, string> };
    // Flat-map shape from error.flatten().fieldErrors — only fields with a
    // message are forwarded (so name/email/message all present, company
    // omitted because it is optional and could not fail this case).
    expect(body.errors?.name).toMatch(/name/i);
    expect(body.errors?.email).toMatch(/email/i);
    expect(body.errors?.message).toMatch(/message/i);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 200 without sending when the honeypot field is non-empty', async () => {
    const { POST } = await import('@/app/api/contact/route');
    const res = await POST(
      makePostRequest({
        name: 'Real Person',
        email: 'real@example.com',
        company: 'Acme',
        message: 'hi',
        website: 'http://spam.example',
      }),
    );
    // Honeypot trap returns the same envelope as success so a bot can't
    // tell — silent 200 IS the contract.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; sentAt?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.sentAt).toBe('string');
    expect(new Date(body.sentAt ?? '').toString()).not.toBe('Invalid Date');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 200 with sentAt and sends one email with all four fields to POLSIA_COMPANY_EMAIL', async () => {
    const { POST } = await import('@/app/api/contact/route');
    const res = await POST(
      makePostRequest({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        company: 'Analytical Engines',
        message: 'Hello.',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; sentAt?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.sentAt).toBe('string');
    expect(new Date(body.sentAt ?? '').toString()).not.toBe('Invalid Date');

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const callArg = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html?: string;
      text?: string;
    };
    expect(callArg.to).toBe(RECIPIENT);
    expect(callArg.subject).toContain('New contact form submission');
    // All four field values must land in the email somewhere (subject, html,
    // or text). The template renders each as its own paragraph line, so a
    // simple substring check across the union is sufficient and tolerant of
    // any future template re-styling.
    const blob = `${callArg.subject} ${callArg.html ?? ''} ${callArg.text ?? ''}`;
    expect(blob).toContain('Ada Lovelace');
    expect(blob).toContain('ada@example.com');
    expect(blob).toContain('Analytical Engines');
    expect(blob).toContain('Hello.');
  });
});
