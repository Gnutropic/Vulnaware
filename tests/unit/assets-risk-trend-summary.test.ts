import { describe, expect, it } from 'vitest';
import { calculateRiskScoreChange } from '@/lib/business/assets-risk-trend-summary';

describe('calculateRiskScoreChange', () => {
  it('orders points by timestamp before comparing the scores', () => {
    const result = calculateRiskScoreChange([
      { scannedAt: '2026-06-03T12:00:00.000Z', score: 6.1 },
      { scannedAt: '2026-06-01T12:00:00.000Z', score: 4.2 },
    ]);

    expect(result).toMatchObject({
      earliestScannedAt: '2026-06-01T12:00:00.000Z',
      earliestScore: 4.2,
      latestScannedAt: '2026-06-03T12:00:00.000Z',
      latestScore: 6.1,
    });
    expect(result?.delta).toBeCloseTo(1.9, 10);
  });

  it.each([
    ['positive', 4.2, 6.1, 1.9],
    ['negative', 6.1, 4.2, -1.9],
    ['zero', 4.2, 4.2, 0],
  ])('returns a %s score delta', (_direction, earliestScore, latestScore, delta) => {
    const result = calculateRiskScoreChange([
      { scannedAt: '2026-06-01T12:00:00.000Z', score: earliestScore },
      { scannedAt: '2026-06-03T12:00:00.000Z', score: latestScore },
    ]);

    expect(result).toMatchObject({ earliestScore, latestScore });
    expect(result?.delta).toBeCloseTo(delta, 10);
  });

  it('returns unavailable for zero or one dated point', () => {
    expect(calculateRiskScoreChange([])).toBeNull();
    expect(
      calculateRiskScoreChange([{ scannedAt: '2026-06-01T12:00:00.000Z', score: 4.2 }]),
    ).toBeNull();
  });

  it('returns unavailable when invalid records leave only one usable point', () => {
    expect(
      calculateRiskScoreChange([
        { scannedAt: 'not-a-date', score: 4.2 },
        { scannedAt: '2026-06-01T12:00:00.000Z', score: 5.1 },
        { scannedAt: '2026-06-02T12:00:00.000Z', score: Number.NaN },
      ]),
    ).toBeNull();
  });

  it('ignores undated and non-finite points', () => {
    const result = calculateRiskScoreChange([
      { scannedAt: 'not-a-date', score: 1 },
      { scannedAt: '2026-06-01T12:00:00.000Z', score: Number.NaN },
      { scannedAt: '2026-06-02T12:00:00.000Z', score: 4.2 },
      { scannedAt: '2026-06-03T12:00:00.000Z', score: 6.1 },
    ]);

    expect(result).toMatchObject({
      earliestScannedAt: '2026-06-02T12:00:00.000Z',
      earliestScore: 4.2,
      latestScannedAt: '2026-06-03T12:00:00.000Z',
      latestScore: 6.1,
    });
    expect(result?.delta).toBeCloseTo(1.9, 10);
  });
});
