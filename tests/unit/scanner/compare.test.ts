// @vitest-environment node
// Dedicated coverage for the shared compareFindings comparator.
// /api/scan, /api/scan/[id], /api/scan/[id]/report, and the run-scan
// orchestrator all dispatch through this single function, so any drift
// between write-side and read-side sort surfaces here first.
import { describe, expect, it } from 'vitest';

import { compareFindings, type FindingSortKey } from '@/lib/business/scanner/prioritize';

const k = (overrides: Partial<FindingSortKey>): FindingSortKey => ({
  priorityScore: 5.0,
  severity: 'medium',
  cvssScore: 5.0,
  cveId: 'CVE-1',
  kevListed: false,
  ...overrides,
});

describe('compareFindings', () => {
  it('orders by priorityScore desc', () => {
    expect(compareFindings(k({ priorityScore: 8 }), k({ priorityScore: 5 }))).toBeLessThan(0);
    expect(compareFindings(k({ priorityScore: 5 }), k({ priorityScore: 8 }))).toBeGreaterThan(0);
    expect(compareFindings(k({ priorityScore: 4 }), k({ priorityScore: 4 }))).toBe(0);
  });

  it('hoists KEV-listed above equal-priority non-KEV', () => {
    const kev = k({ priorityScore: 4, cveId: 'CVE-KEV', kevListed: true });
    const plain = k({ priorityScore: 4, cveId: 'CVE-OTHER', kevListed: false });
    // a (kev) sorts first → negative return value.
    expect(compareFindings(kev, plain)).toBeLessThan(0);
    expect(compareFindings(plain, kev)).toBeGreaterThan(0);
  });

  it('keeps the four-tier tiebreaker when both sides are KEV-listed', () => {
    // priority even + both KEV + different CVSS → CVSS desc wins.
    const high = k({ priorityScore: 4, cvssScore: 9.0, cveId: 'CVE-A', kevListed: true });
    const low = k({ priorityScore: 4, cvssScore: 5.0, cveId: 'CVE-B', kevListed: true });
    expect(compareFindings(high, low)).toBeLessThan(0);
  });

  it('falls back to cveId asc when every other tier is even', () => {
    const a = k({ cveId: 'CVE-2014-0160', kevListed: true });
    const b = k({ cveId: 'CVE-2021-44228', kevListed: true });
    expect(compareFindings(a, b)).toBeLessThan(0);
  });

  it('treats null priorityScore as zero', () => {
    expect(compareFindings(k({ priorityScore: null }), k({ priorityScore: 0 }))).toBe(0);
    expect(compareFindings(k({ priorityScore: 1 }), k({ priorityScore: null }))).toBeLessThan(0);
    expect(compareFindings(k({ priorityScore: null }), k({ priorityScore: 1 }))).toBeGreaterThan(0);
  });
});
