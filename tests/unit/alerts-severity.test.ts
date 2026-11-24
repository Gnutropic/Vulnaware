// Pure Node test for the severity filter helpers. Locks the round-
// trip contract between the alerts page's chip row, the URL writer
// (`buildEffectiveQs`), and the route handlers:

import { describe, expect, it } from 'vitest';
import { formatSeverityFilter, parseSeverityFilter } from '@/lib/business/alerts-severity';

describe('parseSeverityFilter', () => {
  it('parses a single canonical literal', () => {
    expect(parseSeverityFilter('critical')).toEqual(['critical']);
  });

  it('parses two comma-separated canonical literals', () => {
    expect(parseSeverityFilter('critical,high')).toEqual(['critical', 'high']);
  });

  it('parses all four canonical literals', () => {
    expect(parseSeverityFilter('critical,high,medium,low')).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
  });

  it('preserves arbitrary stored values while trimming and deduping', () => {
    expect(parseSeverityFilter(' legacy-value , critical,legacy-value,High ')).toEqual([
      'critical',
      'High',
      'legacy-value',
    ]);
  });

  it('returns [] for null / undefined / empty', () => {
    expect(parseSeverityFilter(null)).toEqual([]);
    expect(parseSeverityFilter(undefined)).toEqual([]);
    expect(parseSeverityFilter('')).toEqual([]);
  });

  it('tolerates whitespace around each entry', () => {
    expect(parseSeverityFilter(' critical , high ')).toEqual(['critical', 'high']);
  });

  it('dedupes repeated literal entries', () => {
    expect(parseSeverityFilter('critical,critical,high')).toEqual(['critical', 'high']);
  });

  it('returns [] for an all-whitespace input', () => {
    expect(parseSeverityFilter(' , , ')).toEqual([]);
  });
});

describe('formatSeverityFilter', () => {
  it('emits CSV in canonical critical → high → medium → low order', () => {
    expect(formatSeverityFilter(new Set(['high', 'critical']))).toBe('critical,high');
    expect(formatSeverityFilter(new Set(['low', 'high', 'critical', 'medium']))).toBe(
      'critical,high,medium,low',
    );
  });

  it('returns null when the Set is empty', () => {
    expect(formatSeverityFilter(new Set())).toBe(null);
  });

  it('returns null when the Set is null or undefined', () => {
    expect(formatSeverityFilter(null)).toBe(null);
    expect(formatSeverityFilter(undefined)).toBe(null);
  });

  it('formats a single-element Set', () => {
    expect(formatSeverityFilter(new Set(['medium']))).toBe('medium');
  });

  it('formats custom values after standard severities in deterministic order', () => {
    expect(formatSeverityFilter(new Set(['zeta', 'criticality', 'high']))).toBe(
      'high,criticality,zeta',
    );
  });
});

describe('parseSeverityFilter ↔ formatSeverityFilter round-trip', () => {
  it('round-trips every subset of canonical severities', () => {
    const all = ['critical', 'high', 'medium', 'low'] as const;
    for (const seed of all) {
      const set = new Set([seed]);
      const formatted = formatSeverityFilter(set);
      expect(formatted).toBe(seed);
      expect(parseSeverityFilter(formatted)).toEqual([seed]);
    }
  });

  it('round-trips "critical,high" through parse + format', () => {
    const formatted = formatSeverityFilter(new Set(['critical', 'high']));
    expect(formatted).toBe('critical,high');
    const parsed = parseSeverityFilter(formatted);
    expect(parsed).toEqual(['critical', 'high']);
    // Re-format matches the original canonical CSV.
    expect(formatSeverityFilter(new Set(parsed))).toBe('critical,high');
  });
});
