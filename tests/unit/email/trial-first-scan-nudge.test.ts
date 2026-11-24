// @vitest-environment node
// Unit tests for jobs/trial-first-scan-nudge.ts. Pins the brief's "test
// invocation delivers the email via the configured sender helper without
// errors" criterion: with a single eligible candidate, the cron end-to-end
// selects it, calls sendEmail once with the expected subject + cta label +
// dashboard URL, and stamps lastFirstScanNudgeSentAt on the workspace row.
//
// Plus gating controls:
//   - owners who already recorded first_scan_triggered are skipped
//   - owners with no email fallback to a skip (no crash)
//   - per-candidate send failure doesn't abort the rest of the batch

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trialWorkspaceFindMany = vi.fn();
const trialWorkspaceUpdateMany = vi.fn();
const trialFunnelEventFindMany = vi.fn();
const userFindMany = vi.fn();
const sendEmail = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('@/lib/db', () => ({
  prisma: {
    trialWorkspace: {
      findMany: trialWorkspaceFindMany,
      updateMany: trialWorkspaceUpdateMany,
    },
    trialFunnelEvent: {
      findMany: trialFunnelEventFindMany,
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
  fromFor: () => 'VulnAware Notifications <notifications@vulnaware.com>',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  },
}));

// The cron uses NODE_ENV='test' as the auto-run guard; production cron
// runs always have NODE_ENV unset.
process.env.NODE_ENV = 'test';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

beforeEach(() => {
  vi.resetModules();
  trialWorkspaceFindMany.mockReset();
  trialWorkspaceUpdateMany.mockReset();
  trialFunnelEventFindMany.mockReset();
  userFindMany.mockReset();
  sendEmail.mockReset();
});

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe('trial-first-scan-nudge cron', () => {
  it('delivers the nudge for one eligible candidate and stamps the workspace', async () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const wsRow = { id: 'ws-A', ownerUserId: 'u-A' };
    trialWorkspaceFindMany.mockResolvedValueOnce([wsRow]);
    trialFunnelEventFindMany.mockResolvedValueOnce([]);
    userFindMany.mockResolvedValueOnce([{ id: 'u-A', email: 'owner@example.com', name: 'Alice' }]);
    sendEmail.mockResolvedValueOnce({ id: 'msg-1' });
    trialWorkspaceUpdateMany.mockResolvedValueOnce({ count: 1 });

    const { main } = await import('../../../jobs/trial-first-scan-nudge');
    await main(now);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const callArg = sendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(callArg.to).toBe('owner@example.com');
    expect(callArg.subject).toBe('Run your first VulnAware scan');
    expect(callArg.html).toContain('Run your first scan');
    expect(callArg.html).toContain('http://localhost:3000/dashboard');
    expect(callArg.text).toContain('http://localhost:3000/dashboard');

    expect(trialWorkspaceUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = trialWorkspaceUpdateMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] } };
      data: { lastFirstScanNudgeSentAt: Date };
    };
    expect(updateArgs.where.id.in).toEqual(['ws-A']);
    expect(updateArgs.data.lastFirstScanNudgeSentAt).toBeInstanceOf(Date);
  });

  it('skips candidates who already have a first_scan_triggered event', async () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const wsRow = { id: 'ws-B', ownerUserId: 'u-B' };
    trialWorkspaceFindMany.mockResolvedValueOnce([wsRow]);
    trialFunnelEventFindMany.mockResolvedValueOnce([{ userId: 'u-B' }]);
    userFindMany.mockResolvedValueOnce([{ id: 'u-B', email: 'owner@example.com', name: 'Bob' }]);

    const { main } = await import('../../../jobs/trial-first-scan-nudge');
    await main(now);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(trialWorkspaceUpdateMany).not.toHaveBeenCalled();
  });

  it('skips candidates that lack a User row (no crash)', async () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const wsRow = { id: 'ws-C', ownerUserId: 'u-C' };
    trialWorkspaceFindMany.mockResolvedValueOnce([wsRow]);
    trialFunnelEventFindMany.mockResolvedValueOnce([]);
    userFindMany.mockResolvedValueOnce([]);

    const { main } = await import('../../../jobs/trial-first-scan-nudge');
    await main(now);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(trialWorkspaceUpdateMany).not.toHaveBeenCalled();
  });

  it('keeps sending to later candidates when one send throws', async () => {
    const now = new Date('2026-07-23T12:00:00Z');
    const wsA = { id: 'ws-A', ownerUserId: 'u-A' };
    const wsB = { id: 'ws-B', ownerUserId: 'u-B' };
    trialWorkspaceFindMany.mockResolvedValueOnce([wsA, wsB]);
    trialFunnelEventFindMany.mockResolvedValueOnce([]);
    userFindMany.mockResolvedValueOnce([
      { id: 'u-A', email: 'a@example.com', name: 'Alice' },
      { id: 'u-B', email: 'b@example.com', name: 'Bob' },
    ]);
    sendEmail.mockRejectedValueOnce(new Error('proxy down'));
    sendEmail.mockResolvedValueOnce({ id: 'msg-2' });
    trialWorkspaceUpdateMany.mockResolvedValue({ count: 1 });

    // Silence the deploy-log breadcrumb from the per-catch handler so
    // the test output stays clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { main } = await import('../../../jobs/trial-first-scan-nudge');
    await main(now);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    // Only B was stamped (A's send threw).
    expect(trialWorkspaceUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = trialWorkspaceUpdateMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] } };
    };
    expect(updateArgs.where.id.in).toEqual(['ws-B']);

    consoleError.mockRestore();
  });

  it('passes the 24h window and candidate-owner filter to findMany', async () => {
    const now = new Date('2026-07-23T12:00:00Z');
    trialWorkspaceFindMany.mockResolvedValueOnce([]);
    trialFunnelEventFindMany.mockResolvedValueOnce([]);

    const { main } = await import('../../../jobs/trial-first-scan-nudge');
    await main(now);

    const findArgs = trialWorkspaceFindMany.mock.calls[0]?.[0] as {
      where: {
        createdAt: { lte: Date };
        trialEndsAt: { gt: Date };
        lastFirstScanNudgeSentAt: null;
      };
      select: { id: true; ownerUserId: true };
    };
    const expectedWindowStart = new Date(now.getTime() - 24 * 60 * 60_000);
    expect(findArgs.where.createdAt.lte.getTime()).toBe(expectedWindowStart.getTime());
    expect(findArgs.where.trialEndsAt.gt.getTime()).toBe(now.getTime());
    expect(findArgs.where.lastFirstScanNudgeSentAt).toBeNull();
    expect(findArgs.select).toEqual({ id: true, ownerUserId: true });

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
