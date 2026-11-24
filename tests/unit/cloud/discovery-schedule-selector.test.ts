// @vitest-environment node
// Unit tests for the due-schedule selector helper exposed from the cron
// entry. The selector is the predicate behind the cron's
// `where: { nextRunAt: { lte: now } }` Prisma filter — by isolating it into
// a pure function we can pin behavior without spinning up a real DB.

import { describe, expect, it, vi } from 'vitest';

// The cron file transitively imports `server-only`, `prisma`, and the
// business lib. Stub them so the import doesn't trip in vitest.
vi.mock('server-only', () => ({}));
vi.mock('../../../src/lib/db', () => ({
  prisma: {
    cloudDiscoverySchedule: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    membership: { findMany: vi.fn() },
    awsConnection: { findMany: vi.fn() },
    azureConnection: { findMany: vi.fn() },
    gcpConnection: { findMany: vi.fn() },
    awsDiscoveryRun: { create: vi.fn() },
  },
}));
vi.mock('../../../src/lib/business/cloud/discovery-schedule', () => ({
  dispatchDiscoveryRun: vi.fn(),
}));

import { isScheduleDue } from '../../../jobs/cloud-discovery-run';

describe('isScheduleDue', () => {
  it('flags a schedule whose nextRunAt is in the past as due', () => {
    const now = new Date('2026-07-22T12:00:00Z');
    const past = new Date('2026-07-22T11:59:00Z');
    expect(isScheduleDue({ nextRunAt: past }, now)).toBe(true);
  });

  it('flags a schedule whose nextRunAt is exactly now as due', () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    expect(isScheduleDue({ nextRunAt: now }, now)).toBe(true);
  });

  it('rejects a schedule whose nextRunAt is in the future', () => {
    const now = new Date('2026-07-22T12:00:00Z');
    const future = new Date('2026-07-22T12:00:01Z');
    expect(isScheduleDue({ nextRunAt: future }, now)).toBe(false);
  });

  it('treats a null nextRunAt as due (defensive — should never happen in practice)', () => {
    const now = new Date('2026-07-22T12:00:00Z');
    expect(isScheduleDue({ nextRunAt: null }, now)).toBe(true);
  });
});
