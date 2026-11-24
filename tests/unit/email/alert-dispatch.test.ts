// @vitest-environment node
// Unit tests for jobs/alert-dispatch.ts. Pins the brief's "manual smoke
// test of main(new Date()) delivers exactly one alert and the row is
// stamped with dispatchedAt" criterion: with one Alert row in scope,
// the cron end-to-end selects it, joins to a finding's cveId +
// memberships['admin'] → users.email, calls sendEmail once per admin
// recipient with the expected subject + html cta URL, then stamps
// dispatchedAt on the row.
//
// Plus gating controls:
//   - the selector's where pins `dispatchedAt == null` so a stamped
//     row is never picked up again
//   - two-admin fan-out sends two envelopes with distinct `to` but
//     identical body and stamps only when both succeeded
//   - one failed recipient leaves the row unstamped (next tick retries)
//   - the selector issues a SINGLE batched vulnerabilityFinding.findMany
//     across every in-scope findingId

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alertFindMany = vi.fn();
const alertUpdate = vi.fn();
const vulnerabilityFindingFindMany = vi.fn();
const membershipFindMany = vi.fn();
const userFindMany = vi.fn();
const sendEmail = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('@/lib/db', () => ({
  prisma: {
    alert: {
      findMany: alertFindMany,
      update: alertUpdate,
    },
    vulnerabilityFinding: {
      findMany: vulnerabilityFindingFindMany,
    },
    membership: {
      findMany: membershipFindMany,
    },
    user: {
      findMany: userFindMany,
    },
  },
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail,
}));

vi.mock('@/lib/email/from', () => ({
  fromFor: () => 'VulnAware Alerts <alerts@vulnaware.com>',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    EMAIL_FROM_ALERTS: 'VulnAware Alerts <alerts@vulnaware.com>',
  },
}));

// The cron uses NODE_ENV='test' as the auto-run guard; production cron
// runs always have NODE_ENV unset.
process.env.NODE_ENV = 'test';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

beforeEach(() => {
  vi.resetModules();
  alertFindMany.mockReset();
  alertUpdate.mockReset();
  vulnerabilityFindingFindMany.mockReset();
  membershipFindMany.mockReset();
  userFindMany.mockReset();
  sendEmail.mockReset();
});

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

const BASE = 'http://localhost:3000';
const FIXED_NOW = new Date('2026-07-23T12:00:00Z');
const WINDOW_START = new Date(FIXED_NOW.getTime() - 60 * 1000);

describe('alert-dispatch cron', () => {
  it('delivers one envelope per admin recipient and stamps dispatchedAt', async () => {
    const alertRow = {
      id: 'alert-1',
      teamId: 'team-A',
      findingId: 'finding-1',
      severity: 'critical',
      source: 'kev',
      createdAt: WINDOW_START,
    };
    alertFindMany.mockResolvedValueOnce([alertRow]);
    vulnerabilityFindingFindMany.mockResolvedValueOnce([
      { id: 'finding-1', cveId: 'CVE-2024-9999' },
    ]);
    membershipFindMany.mockResolvedValueOnce([{ userId: 'u-A', teamId: 'team-A' }]);
    userFindMany.mockResolvedValueOnce([{ id: 'u-A', email: 'admin@example.com' }]);
    sendEmail.mockResolvedValueOnce({ id: 'msg-1' });
    alertUpdate.mockResolvedValueOnce({ id: 'alert-1' });

    const { main } = await import('../../../jobs/alert-dispatch');
    await main(FIXED_NOW);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const callArg = sendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(callArg.to).toBe('admin@example.com');
    expect(callArg.subject).toBe('[critical] CVE-2024-9999');
    expect(callArg.html).toContain(`${BASE}/alerts/alert-1`);
    expect(callArg.text).toContain(`${BASE}/alerts/alert-1`);

    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = alertUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { dispatchedAt: Date };
    };
    expect(updateArgs.where.id).toBe('alert-1');
    expect(updateArgs.data.dispatchedAt).toBe(FIXED_NOW);
  });

  it('pins dispatchedAt===null and the 60s window in the selector', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    vulnerabilityFindingFindMany.mockResolvedValueOnce([]);
    membershipFindMany.mockResolvedValueOnce([]);
    userFindMany.mockResolvedValueOnce([]);

    const { main } = await import('../../../jobs/alert-dispatch');
    await main(FIXED_NOW);

    const alertFindArgs = alertFindMany.mock.calls[0]?.[0] as {
      where: { dispatchedAt: null; createdAt: { lte: Date } };
      select: Record<string, boolean>;
    };
    expect(alertFindArgs.where.dispatchedAt).toBeNull();
    expect(alertFindArgs.where.createdAt.lte.getTime()).toBe(WINDOW_START.getTime());
    expect(alertFindArgs.select).toEqual({
      id: true,
      teamId: true,
      findingId: true,
      severity: true,
      source: true,
      createdAt: true,
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('excludes already-dispatched rows via the where filter (selector pins the clause)', async () => {
    alertFindMany.mockResolvedValueOnce([]);
    vulnerabilityFindingFindMany.mockResolvedValueOnce([]);
    membershipFindMany.mockResolvedValueOnce([]);
    userFindMany.mockResolvedValueOnce([]);

    const { main } = await import('../../../jobs/alert-dispatch');
    await main(FIXED_NOW);

    const alertFindArgs = alertFindMany.mock.calls[0]?.[0] as {
      where: { dispatchedAt: null; createdAt: { lte: Date } };
    };
    // dispatchedAt:null is the only knob that filters pre-stamped rows.
    expect(alertFindArgs.where.dispatchedAt).toBeNull();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('fans out to two admin recipients with distinct to and stamps after both succeed', async () => {
    const alertRow = {
      id: 'alert-2',
      teamId: 'team-B',
      findingId: 'finding-2',
      severity: 'high',
      source: 'vulncheck',
      createdAt: WINDOW_START,
    };
    alertFindMany.mockResolvedValueOnce([alertRow]);
    vulnerabilityFindingFindMany.mockResolvedValueOnce([
      { id: 'finding-2', cveId: 'CVE-2025-0007' },
    ]);
    membershipFindMany.mockResolvedValueOnce([
      { userId: 'u-B1', teamId: 'team-B' },
      { userId: 'u-B2', teamId: 'team-B' },
    ]);
    userFindMany.mockResolvedValueOnce([
      { id: 'u-B1', email: 'first@example.com' },
      { id: 'u-B2', email: 'second@example.com' },
    ]);
    sendEmail.mockResolvedValueOnce({ id: 'msg-2a' });
    sendEmail.mockResolvedValueOnce({ id: 'msg-2b' });
    alertUpdate.mockResolvedValueOnce({ id: 'alert-2' });

    const { main } = await import('../../../jobs/alert-dispatch');
    await main(FIXED_NOW);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const recipients = sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients).toEqual(['first@example.com', 'second@example.com']);

    const subjects = sendEmail.mock.calls.map((c) => (c[0] as { subject: string }).subject);
    expect(subjects).toEqual(['[high] CVE-2025-0007', '[high] CVE-2025-0007']);

    // Stamp runs once and only after the second send resolves.
    expect(alertUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = alertUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { dispatchedAt: Date };
    };
    expect(updateArgs.where.id).toBe('alert-2');
    expect(updateArgs.data.dispatchedAt).toBe(FIXED_NOW);
  });

  it('keeps sending to later admins and leaves the row unstamped when one send throws', async () => {
    const alertRow = {
      id: 'alert-3',
      teamId: 'team-C',
      findingId: 'finding-3',
      severity: 'medium',
      source: 'kev',
      createdAt: WINDOW_START,
    };
    alertFindMany.mockResolvedValueOnce([alertRow]);
    vulnerabilityFindingFindMany.mockResolvedValueOnce([
      { id: 'finding-3', cveId: 'CVE-2024-1111' },
    ]);
    membershipFindMany.mockResolvedValueOnce([
      { userId: 'u-C1', teamId: 'team-C' },
      { userId: 'u-C2', teamId: 'team-C' },
    ]);
    userFindMany.mockResolvedValueOnce([
      { id: 'u-C1', email: 'broken@example.com' },
      { id: 'u-C2', email: 'good@example.com' },
    ]);
    sendEmail.mockRejectedValueOnce(new Error('proxy down'));
    sendEmail.mockResolvedValueOnce({ id: 'msg-3b' });

    // Silence the deploy-log breadcrumb from the per-recipient catch handler
    // so the test output stays clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { main } = await import('../../../jobs/alert-dispatch');
    await main(FIXED_NOW);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    // Partial failure → row stays unstamped, so next tick retries.
    expect(alertUpdate).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('resolves cveId via a SINGLE batched vulnerabilityFinding.findMany', async () => {
    const alertRowA = {
      id: 'alert-A',
      teamId: 'team-A',
      findingId: 'finding-A',
      severity: 'low',
      source: 'kev',
      createdAt: WINDOW_START,
    };
    const alertRowB = {
      id: 'alert-B',
      teamId: 'team-B',
      findingId: 'finding-B',
      severity: 'low',
      source: 'kev',
      createdAt: WINDOW_START,
    };
    alertFindMany.mockResolvedValueOnce([alertRowA, alertRowB]);
    vulnerabilityFindingFindMany.mockResolvedValueOnce([
      { id: 'finding-A', cveId: 'CVE-2024-A111' },
      { id: 'finding-B', cveId: 'CVE-2024-B111' },
    ]);
    membershipFindMany.mockResolvedValueOnce([{ userId: 'u-A', teamId: 'team-A' }]);
    userFindMany.mockResolvedValueOnce([{ id: 'u-A', email: 'a@example.com' }]);
    sendEmail.mockResolvedValue({ id: 'msg' });
    alertUpdate.mockResolvedValue({ id: 'x' });

    const { main } = await import('../../../jobs/alert-dispatch');
    await main(FIXED_NOW);

    expect(vulnerabilityFindingFindMany).toHaveBeenCalledTimes(1);
    const findingArgs = vulnerabilityFindingFindMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] } };
      select: Record<string, boolean>;
    };
    expect(findingArgs.where.id.in).toEqual(['finding-A', 'finding-B']);
    expect(findingArgs.select).toEqual({ id: true, cveId: true });
  });
});
