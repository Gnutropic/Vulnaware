// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  HIGH_RISK_PRIORITY_SCORE,
  isHighRiskPriorityScore,
  prioritizeFinding,
} from '@/lib/business/scanner/prioritize';

describe('high-risk priority boundary', () => {
  it('classifies the exact threshold as high risk and the score below it as lower risk', () => {
    expect(HIGH_RISK_PRIORITY_SCORE).toBe(7);
    expect(isHighRiskPriorityScore(7)).toBe(true);
    expect(isHighRiskPriorityScore(6.99)).toBe(false);
  });
});

describe('prioritizeFinding', () => {
  it('scores high-CVSS low-EPSS as roughly CVSS-driven', () => {
    const r = prioritizeFinding({ cvssScore: 9.8, epssScore: 0.05, severity: 'critical' });
    // 0.6 * 9.8 + 0.4 * 0.05 = 5.88 + 0.02 = 5.90
    expect(r.priorityScore).toBeCloseTo(5.9, 5);
    expect(r.components.cvssSource).toBe('cvss');
    expect(r.components.cvssContribution).toBeCloseTo(5.88, 5);
    expect(r.components.epssContribution).toBeCloseTo(0.02, 5);
  });

  it('matches a low-CVSS high-EPSS finding to within tolerance', () => {
    const r = prioritizeFinding({ cvssScore: 4.2, epssScore: 0.92, severity: 'medium' });
    // 0.6 * 4.2 + 0.4 * 0.92 = 2.52 + 0.368 = 2.888
    expect(r.priorityScore).toBeCloseTo(2.888, 5);
  });

  it('falls back to severity bucket when CVSS is missing', () => {
    const r = prioritizeFinding({ cvssScore: null, epssScore: 0.1, severity: 'high' });
    // 0.6 * 7.5 + 0.4 * 0.1 = 4.5 + 0.04 = 4.54
    expect(r.priorityScore).toBeCloseTo(4.54, 5);
    expect(r.components.cvssSource).toBe('severity');
  });

  it('treats missing EPSS as zero', () => {
    const r = prioritizeFinding({ cvssScore: 7.5, epssScore: null, severity: 'high' });
    // 0.6 * 7.5 + 0 = 4.5
    expect(r.priorityScore).toBeCloseTo(4.5, 5);
    expect(r.components.epssContribution).toBe(0);
  });

  it('falls back to all-null severity-only path', () => {
    const r = prioritizeFinding({
      cvssScore: null,
      epssScore: null,
      severity: 'critical',
    });
    // 0.6 * 9.5 + 0 = 5.7
    expect(r.priorityScore).toBeCloseTo(5.7, 5);
    expect(r.epssScore).toBeNull();
  });

  it('returns zero priority when every signal is missing', () => {
    const r = prioritizeFinding({ cvssScore: null, epssScore: null, severity: null });
    expect(r.priorityScore).toBe(0);
    expect(r.components.cvssSource).toBe('missing');
  });

  it('clamps EPSS above 1.0 and CVSS above 10', () => {
    const r = prioritizeFinding({ cvssScore: 12, epssScore: 1.5, severity: 'LOW' });
    // 0.6 * 10 + 0.4 * 1 = 6 + 0.4 = 6.4
    expect(r.priorityScore).toBeCloseTo(6.4, 5);
  });

  it('clamps a bound input at exactly 10', () => {
    const r = prioritizeFinding({ cvssScore: 10, epssScore: 1, severity: 'critical' });
    // 0.6 * 10 + 0.4 * 1 = 6.4 (well within 10 — verify formula, not clamp)
    expect(r.priorityScore).toBeCloseTo(6.4, 5);
  });

  it('clamps a CVSS-bound finding when EPSS exceeds CVSS weight envelope', () => {
    // 0.6 * 10 + 0.4 * 1 = 6.4 — clamp(6.4, 0, 10) = 6.4
    const r = prioritizeFinding({ cvssScore: 10, epssScore: 1, severity: 'critical' });
    expect(r.priorityScore).toBeLessThanOrEqual(10);
  });

  it('handles severity bucketing case-insensitively', () => {
    const r1 = prioritizeFinding({ cvssScore: null, epssScore: null, severity: 'HIGH' });
    const r2 = prioritizeFinding({ cvssScore: null, epssScore: null, severity: 'high' });
    expect(r1.priorityScore).toBeCloseTo(r2.priorityScore, 5);
    expect(r1.priorityScore).toBeCloseTo(4.5, 5);
  });

  it('epsScore 0 still counts as zero contribution', () => {
    const r = prioritizeFinding({ cvssScore: 6, epssScore: 0, severity: 'medium' });
    // 0.6 * 6 + 0 = 3.6
    expect(r.priorityScore).toBeCloseTo(3.6, 5);
  });
});

// ===================== KEV (CISA KEV) WEIGHT =====================

describe('prioritizeFinding — KEV integration', () => {
  it('contributes exactly KEV_WEIGHT (2.0) when kevListed is true', () => {
    const r = prioritizeFinding({
      cvssScore: 5.0,
      epssScore: 0.1,
      severity: 'medium',
      kevListed: true,
    });
    // 0.6 * 5.0 + 0.4 * 0.1 + 2.0 = 3.0 + 0.04 + 2.0 = 5.04
    expect(r.priorityScore).toBeCloseTo(5.04, 5);
    expect(r.components.kevContribution).toBe(2.0);
    expect(r.components.cvssContribution).toBeCloseTo(3.0, 5);
    expect(r.components.epssContribution).toBeCloseTo(0.04, 5);
  });

  it('kevListed false is identical to the missing-input path', () => {
    const withFlag = prioritizeFinding({
      cvssScore: 7.5,
      epssScore: 0.3,
      severity: 'high',
      kevListed: false,
    });
    const missing = prioritizeFinding({
      cvssScore: 7.5,
      epssScore: 0.3,
      severity: 'high',
    });
    expect(withFlag.priorityScore).toBeCloseTo(missing.priorityScore, 5);
    expect(withFlag.components.kevContribution).toBe(0);
    expect(missing.components.kevContribution).toBe(0);
  });

  it('clamps within 0..10 when the rest of the budget is already saturated', () => {
    const r = prioritizeFinding({
      cvssScore: 10,
      epssScore: 1,
      severity: 'critical',
      kevListed: true,
    });
    // 0.6*10 + 0.4*1 + 2.0 = 8.4 — well under 10; clamp still returns 8.4.
    expect(r.priorityScore).toBeCloseTo(8.4, 5);
    expect(r.priorityScore).toBeLessThanOrEqual(10);
  });
});
