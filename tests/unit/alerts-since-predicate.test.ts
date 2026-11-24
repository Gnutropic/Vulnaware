// Brief case #1 — date predicate test. Pure Node test (no React, no DB).
// Locks the contract:
//   - sinceToBoundDate('7d', now) produces `now - 7 days` (UTC ms).
//   - matchesSinceWindow matches when EITHER `createdAt` OR
//     `statusChangedAt` is `>= sinceBound` (or-clause semantics).
//   - statusChangedAt === null cannot match its own arm; the
//     `createdAt` arm is then the only path that can include the row.

import { describe, expect, it } from 'vitest';
import { matchesSinceWindow, sinceToBoundDate } from '@/lib/business/alerts-since';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const SEVEN_D = sinceToBoundDate('7d', NOW);
const THIRTY_D = sinceToBoundDate('30d', NOW);
const NINETY_D = sinceToBoundDate('90d', NOW);

describe('sinceToBoundDate', () => {
  it('produces now - 7*86400000 for "7d"', () => {
    expect(SEVEN_D.toISOString()).toBe('2026-07-20T12:00:00.000Z');
  });

  it('produces now - 30*86400000 for "30d"', () => {
    expect(THIRTY_D.getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
  });

  it('produces now - 90*86400000 for "90d"', () => {
    expect(NINETY_D.getTime()).toBe(NOW.getTime() - 90 * 86_400_000);
  });
});

describe('matchesSinceWindow (just inside / just outside the trailing 7-day boundary)', () => {
  it('includes a row whose both timestamps sit inside the window', () => {
    const row = {
      createdAt: new Date('2026-07-25T00:00:00.000Z'),
      statusChangedAt: new Date('2026-07-26T00:00:00.000Z'),
    };
    expect(matchesSinceWindow(row, SEVEN_D)).toBe(true);
  });

  it('excludes a row whose both timestamps sit outside the window', () => {
    const row = {
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      statusChangedAt: new Date('2026-07-05T00:00:00.000Z'),
    };
    expect(matchesSinceWindow(row, SEVEN_D)).toBe(false);
  });

  it('includes a long-resolved alert whose statusChangedAt flips into the window (createdAt outside)', () => {
    // Customer asked an operator to set an alert to in_progress last week;
    // it had sat quietly for six months and was re-pinged yesterday. The
    // chip surfaces it via the statusChangedAt arm even though createdAt
    // is far older.
    const row = {
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      statusChangedAt: new Date('2026-07-26T00:00:00.000Z'),
    };
    expect(matchesSinceWindow(row, SEVEN_D)).toBe(true);
  });

  it('includes a brand-new row whose statusChangedAt is null via the createdAt arm', () => {
    const row = {
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
      statusChangedAt: null,
    };
    expect(matchesSinceWindow(row, SEVEN_D)).toBe(true);
  });

  it('excludes a row whose createdAt is inside but statusChangedAt is null AND we shift the window past createdAt', () => {
    // Same row, but query asks for "Last 1d" — createdAt is no longer
    // inside, statusChangedAt is null. NEITHER arm matches → EXCLUDED.
    const oneDayBound = new Date(NOW.getTime() - 1 * 86_400_000);
    const row = {
      createdAt: new Date('2026-07-25T00:00:00.000Z'),
      statusChangedAt: null,
    };
    expect(matchesSinceWindow(row, oneDayBound)).toBe(false);
  });

  it('excludes a row whose createdAt is outside AND statusChangedAt is null (cold-start row that never got touched)', () => {
    const row = {
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      statusChangedAt: null,
    };
    expect(matchesSinceWindow(row, SEVEN_D)).toBe(false);
  });

  it('matches the inclusive boundary: createdAt === sinceBound still INCLUDES', () => {
    // Prisma `gte` is inclusive — a row written at exactly the bound
    // should still surface. The mirror predicate honors that.
    const row = {
      createdAt: SEVEN_D,
      statusChangedAt: null,
    };
    expect(matchesSinceWindow(row, SEVEN_D)).toBe(true);
  });
});
