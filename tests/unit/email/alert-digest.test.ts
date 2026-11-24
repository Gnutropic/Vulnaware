// @vitest-environment node
// Unit tests for jobs/alert-digest.ts. Mirrors alerts-dispatch's vibe —
// seed a single fixture with mocked prisma + sendEmail + env, then run
// the full pipeline via `main(new Date())` so the selector + sender run
// in series the way the cron does.
//
// Coverage pinpoints (per brief §2 / tests):
//   1. Selector only surfaces critical/high + unacknowledged rows.
//   2. Active vs invited WorkspaceMember mix → only active recipients.
//   3. Empty-day branch (zero alerts) still fires (all-clear) and stamps.
//   4. Paused team (digestEnabled=false) → no email, no stamp advance.
//   5. Per-team error isolation: one team's sendEmail throws; the other
//      completes; the failing team's stamp does NOT advance.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamFindMany = vi.fn();
const teamUpdate = vi.fn();
const teamFindUnique = vi.fn();
const alertFindMany = vi.fn();
const workspaceMemberFindMany = vi.fn();

const sendEmail = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('@/lib/db', () => ({
  prisma: {
    team: {
      findMany: teamFindMany,
      findUnique: teamFindUnique,
      update: teamUpdate,
    },
    alert: {
      findMany: alertFindMany,
    },
    workspaceMember: {
      findMany: workspaceMemberFindMany,
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
  teamFindMany.mockReset();
  teamFindUnique.mockReset();
  teamUpdate.mockReset();
  alertFindMany.mockReset();
  workspaceMemberFindMany.mockReset();
  sendEmail.mockReset();
});

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

const BASE = 'http://localhost:3000';
const FIXED_NOW = new Date('2026-07-23T12:00:00Z');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const WINDOW_START = new Date(FIXED_NOW.getTime() - TWENTY_FOUR_HOURS_MS);

interface SeedTeam {
  id: string;
  name: string;
  digestEnabled: boolean | null;
  lastAlertDigestAt: Date | null;
}

// Selector does ONE batched prisma.team.findMany, so the mock is one
// resolved call returning the full eligible team set. The selector
// pushes the digestEnabled filter to prisma (`where.digestEnabled:
// true`); legacy-null rows are unreachable because the column has a
// `@default(true)` so the DB will never carry null.
function seedTeamsOnce(teams: SeedTeam[]) {
  teamFindMany.mockResolvedValueOnce(
    teams.map((t) => ({
      id: t.id,
      name: t.name,
      lastAlertDigestAt: t.lastAlertDigestAt,
    })),
  );
}

describe('alert-digest cron', () => {
  it('selects only critical/high unacknowledged rows from the last 24h and emails active members', async () => {
    // Two eligible alert rows + one medium + one acknowledged → selector
    // should retain only the eligible pair. Active member + invited
    // member → only the active one receives mail.
    const team: SeedTeam = {
      id: 'team-A',
      name: 'Acme Corp',
      digestEnabled: true,
      lastAlertDigestAt: null,
    };
    seedTeamsOnce([team]);
    teamFindUnique.mockResolvedValueOnce({ lastAlertDigestAt: null });

    const recentCritical = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000);
    const recentHigh = new Date(FIXED_NOW.getTime() - 30 * 60 * 1000);

    alertFindMany.mockResolvedValueOnce([
      {
        id: 'alert-1',
        teamId: 'team-A',
        severity: 'critical',
        createdAt: recentCritical,
        finding: { cveId: 'CVE-2024-9999', asset: { host: '10.0.0.1', port: 443 } },
      },
      {
        id: 'alert-2',
        teamId: 'team-A',
        severity: 'high',
        createdAt: recentHigh,
        finding: { cveId: 'CVE-2025-0007', asset: { host: '10.0.0.1', port: 443 } },
      },
    ]);

    workspaceMemberFindMany.mockResolvedValueOnce([
      { workspaceId: 'team-A', email: 'admin@example.com' },
    ]);

    sendEmail.mockResolvedValueOnce({ id: 'msg-1' });
    teamUpdate.mockResolvedValueOnce({ id: 'team-A' });

    const { main } = await import('../../../jobs/alert-digest');
    await main(FIXED_NOW);

    // Sender path: should pin severity IN ['critical','high'] AND
    // acknowledgedAt IS NULL AND createdAt >= now - 24h.
    const alertArgs = alertFindMany.mock.calls[0]?.[0] as {
      where: {
        teamId: { in: string[] };
        severity: { in: string[] };
        acknowledgedAt: null;
        createdAt: { gte: Date };
      };
      include: {
        finding: { select: { cveId: true; asset: { select: { host: true; port: true } } } };
      };
    };
    expect(alertArgs.where.teamId.in).toEqual(['team-A']);
    expect(alertArgs.where.severity.in).toEqual(['critical', 'high']);
    expect(alertArgs.where.acknowledgedAt).toBeNull();
    expect(alertArgs.where.createdAt.gte.getTime()).toBe(WINDOW_START.getTime());

    // One envelope to ONE eligible recipient.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const callArg = sendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(callArg.to).toBe('admin@example.com');
    expect(callArg.subject).toContain('2 open critical/high alerts in Acme Corp');
    expect(callArg.html).toContain(`${BASE}/alerts/`);
    expect(callArg.html).toContain('CVE-2024-9999');
    expect(callArg.html).toContain('CVE-2025-0007');
    expect(callArg.html).toContain('10.0.0.1:443');
    expect(callArg.text).toContain('Top assets: 10.0.0.1:443.');
    // Per-row URL rendering — every alert in the body must carry an
    // `<a href="${BASE}/alerts/<id>">` anchor so each row links back to
    // its /alerts/[id] page.
    for (const itemId of ['alert-1', 'alert-2']) {
      expect(callArg.html).toContain(`<a href="${BASE}/alerts/${itemId}"`);
      expect(callArg.text).toContain(`${BASE}/alerts/${itemId}`);
    }

    // Stamp updated exactly once.
    expect(teamUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = teamUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { lastAlertDigestAt: Date };
    };
    expect(updateArgs.where.id).toBe('team-A');
    expect(updateArgs.data.lastAlertDigestAt).toEqual(FIXED_NOW);
  });

  it('resolves active vs invited WorkspaceMember correctly (only active recipients)', async () => {
    const team: SeedTeam = {
      id: 'team-R',
      name: 'Roster Co',
      digestEnabled: true,
      lastAlertDigestAt: null,
    };
    seedTeamsOnce([team]);
    teamFindUnique.mockResolvedValueOnce({ lastAlertDigestAt: null });
    // Zero-alert scenario for the all-clear branch.
    alertFindMany.mockResolvedValueOnce([]);
    // The selector's workspaceMember.findMany should pin status='active'
    // so pending invites are filtered at the DB layer.
    workspaceMemberFindMany.mockResolvedValueOnce([
      { workspaceId: 'team-R', email: 'active1@example.com' },
      { workspaceId: 'team-R', email: 'active2@example.com' },
    ]);
    sendEmail.mockResolvedValue({ id: 'msg' });
    teamUpdate.mockResolvedValue({ id: 'team-R' });

    const { main } = await import('../../../jobs/alert-digest');
    await main(FIXED_NOW);

    const memberArgs = workspaceMemberFindMany.mock.calls[0]?.[0] as {
      where: { workspaceId: { in: string[] }; status: string };
      select: { workspaceId: true; email: true };
    };
    expect(memberArgs.where.status).toBe('active');
    expect(memberArgs.where.workspaceId.in).toEqual(['team-R']);

    // All-clear branch fires (zero alerts in window). Two recipients → 2 envelopes.
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const recipients = sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients).toEqual(['active1@example.com', 'active2@example.com']);
    const subject = (sendEmail.mock.calls[0]?.[0] as { subject: string }).subject;
    expect(subject).toContain('all clear in Roster Co');
    expect(teamUpdate).toHaveBeenCalledTimes(1);
  });

  it('fires the all-clear branch + advances the stamp on an empty day', async () => {
    const team: SeedTeam = {
      id: 'team-C',
      name: 'Calm Inc',
      digestEnabled: true,
      lastAlertDigestAt: null,
    };
    seedTeamsOnce([team]);
    teamFindUnique.mockResolvedValueOnce({ lastAlertDigestAt: null });
    alertFindMany.mockResolvedValueOnce([]);
    workspaceMemberFindMany.mockResolvedValueOnce([
      { workspaceId: 'team-C', email: 'lone@example.com' },
    ]);
    sendEmail.mockResolvedValueOnce({ id: 'msg-clear' });
    teamUpdate.mockResolvedValueOnce({ id: 'team-C' });

    const { main } = await import('../../../jobs/alert-digest');
    await main(FIXED_NOW);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0]?.[0] as { subject: string }).subject).toBe(
      '[digest] all clear in Calm Inc',
    );
    expect(teamUpdate).toHaveBeenCalledTimes(1);
  });

  it('skips paused teams (digestEnabled=false) — no email, no stamp', async () => {
    // The selector's where-pins `digestEnabled != false`, so a paused
    // team never lands in teamFindMany at all. Empty result → no sends,
    // no stamp updates.
    teamFindMany.mockResolvedValueOnce([]);
    alertFindMany.mockResolvedValueOnce([]);
    workspaceMemberFindMany.mockResolvedValueOnce([]);

    const { main } = await import('../../../jobs/alert-digest');
    await main(FIXED_NOW);

    expect(teamFindMany).toHaveBeenCalledTimes(1);
    const teamArgs = teamFindMany.mock.calls[0]?.[0] as {
      where: { digestEnabled: boolean };
    };
    expect(teamArgs.where.digestEnabled).toBe(true);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(teamUpdate).not.toHaveBeenCalled();
  });

  it('isolates per-team send failures — failing team does not stamp, sibling team completes', async () => {
    const teamFails: SeedTeam = {
      id: 'team-Fail',
      name: 'Failure Inc',
      digestEnabled: true,
      lastAlertDigestAt: null,
    };
    const teamOk: SeedTeam = {
      id: 'team-Ok',
      name: 'Steady LLC',
      digestEnabled: true,
      lastAlertDigestAt: null,
    };
    seedTeamsOnce([teamFails, teamOk]);

    // First team: send pick is unique and the stamp record exists → try to fire.
    teamFindUnique.mockResolvedValueOnce({ lastAlertDigestAt: null });
    // Second team succeeds.
    teamFindUnique.mockResolvedValueOnce({ lastAlertDigestAt: null });

    alertFindMany.mockResolvedValueOnce([
      {
        id: 'alert-fail',
        teamId: 'team-Fail',
        severity: 'critical',
        createdAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000),
        finding: { cveId: 'CVE-2024-1111', asset: { host: '10.9.9.9', port: 443 } },
      },
      {
        id: 'alert-ok',
        teamId: 'team-Ok',
        severity: 'high',
        createdAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000),
        finding: { cveId: 'CVE-2024-2222', asset: { host: '10.8.8.8', port: 80 } },
      },
    ]);

    workspaceMemberFindMany.mockResolvedValueOnce([
      { workspaceId: 'team-Fail', email: 'bad@example.com' },
      { workspaceId: 'team-Ok', email: 'good@example.com' },
    ]);

    sendEmail.mockRejectedValueOnce(new Error('proxy down'));
    sendEmail.mockResolvedValueOnce({ id: 'msg-ok' });
    teamUpdate.mockResolvedValueOnce({ id: 'team-Ok' });

    // Silence the deploy-log breadcrumb from the per-recipient catch handler.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { main } = await import('../../../jobs/alert-digest');
    await main(FIXED_NOW);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    // Only the OK team's stamp advances — the failure team's stamp does NOT.
    expect(teamUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = teamUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
    };
    expect(updateArgs.where.id).toBe('team-Ok');

    consoleError.mockRestore();
  });
});

describe('shouldFireToday — UTC calendar-day gate', () => {
  it('returns true when lastSentAt is null', async () => {
    const { shouldFireToday } = await import('../../../src/lib/business/alerts-digest');
    expect(shouldFireToday(null, FIXED_NOW)).toBe(true);
  });

  it('returns false when lastSentAt is on the same UTC calendar day', async () => {
    const { shouldFireToday } = await import('../../../src/lib/business/alerts-digest');
    const sameDay = new Date('2026-07-23T03:15:00Z');
    expect(shouldFireToday(sameDay, FIXED_NOW)).toBe(false);
  });

  it('returns true when lastSentAt is on the previous UTC calendar day', async () => {
    const { shouldFireToday } = await import('../../../src/lib/business/alerts-digest');
    const previousDay = new Date('2026-07-22T23:59:59Z');
    expect(shouldFireToday(previousDay, FIXED_NOW)).toBe(true);
  });
});
