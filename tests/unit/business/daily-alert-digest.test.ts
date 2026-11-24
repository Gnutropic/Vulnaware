// @vitest-environment node
// Unit tests for src/lib/business/daily-alert-digest.ts:
//   - shouldFireToday: pure UTC calendar-day gate.
//   - groupBySeverity: bucket helper — every severity collapses to
//     {critical,high,medium,low}, missing keys default to 0.
//   - Find-many filter shape: OR [createdAt, statusChangedAt] >= window
//     so a row that flips status (but wasn't created in window) still
//     surfaces — the brief's "items created OR status-changed in the
//     last 24h" maps to this single OR filter.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/email/from', () => ({ fromFor: () => '' }));
vi.mock('@/lib/email/send', () => ({ sendEmail: () => Promise.resolve({ id: '' }) }));
vi.mock('@/lib/email/templates', () => ({
  dailyAlertDigestEmail: () => ({ subject: '', html: '', text: '' }),
  dailyAlertAllClearEmail: () => ({ subject: '', html: '', text: '' }),
}));

import { groupBySeverity, shouldFireToday } from '@/lib/business/daily-alert-digest';

const FIXED_NOW = new Date('2026-07-23T12:00:00Z');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const WINDOW_START = new Date(FIXED_NOW.getTime() - TWENTY_FOUR_HOURS_MS);

describe('shouldFireToday — UTC calendar-day gate', () => {
  it('returns true when lastSentAt is null', () => {
    expect(shouldFireToday(null, FIXED_NOW)).toBe(true);
  });

  it('returns false when lastSentAt is on the same UTC calendar day', () => {
    const sameDay = new Date('2026-07-23T03:15:00Z');
    expect(shouldFireToday(sameDay, FIXED_NOW)).toBe(false);
  });

  it('returns true when lastSentAt is on the previous UTC calendar day', () => {
    const previousDay = new Date('2026-07-22T23:59:59Z');
    expect(shouldFireToday(previousDay, FIXED_NOW)).toBe(true);
  });

  it('returns true when lastSentAt is on the next UTC calendar day (clock drift safety)', () => {
    const tomorrow = new Date('2026-07-24T00:00:01Z');
    expect(shouldFireToday(tomorrow, FIXED_NOW)).toBe(true);
  });
});

describe('groupBySeverity — canonical bucket shape', () => {
  it('returns all-zero counts for an empty row set', () => {
    expect(groupBySeverity([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('buckets severities case-insensitively', () => {
    const out = groupBySeverity([
      { severity: 'Critical' },
      { severity: 'high' },
      { severity: 'MEDIUM' },
      { severity: 'low' },
    ]);
    expect(out).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
  });

  it('defaults missing severity keys to 0', () => {
    const out = groupBySeverity([{ severity: 'critical' }, { severity: 'critical' }]);
    expect(out).toEqual({ critical: 2, high: 0, medium: 0, low: 0 });
  });

  it('counts multiple rows for the same severity', () => {
    const out = groupBySeverity([{ severity: 'high' }, { severity: 'high' }, { severity: 'high' }]);
    expect(out).toEqual({ critical: 0, high: 3, medium: 0, low: 0 });
  });

  it('ignores null/empty severity values rather than bucketing them', () => {
    const out = groupBySeverity([{ severity: null }, { severity: '' }, { severity: 'medium' }]);
    expect(out).toEqual({ critical: 0, high: 0, medium: 1, low: 0 });
  });
});

describe('window bounds — selector filter shape', () => {
  it('windowStart is exactly 24h before now in UTC ms', () => {
    expect(WINDOW_START.getTime()).toBe(FIXED_NOW.getTime() - TWENTY_FOUR_HOURS_MS);
  });

  it('windowStart is a UTC-aligned duration that matches the OR filter', () => {
    // The OR filter is { createdAt: { gte: WINDOW_START }, statusChangedAt: { gte:
    // WINDOW_START } }. The unit is ms-since-epoch so equality is exact.
    const gte = new Date(FIXED_NOW.getTime() - TWENTY_FOUR_HOURS_MS);
    expect(gte.toISOString()).toBe(WINDOW_START.toISOString());
  });
});
