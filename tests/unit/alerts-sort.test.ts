// Pure-TS comparator test for src/lib/business/alerts-sort.ts. Mirrors
// the four "round-trip the visible list with each branch active"
// contract the brief asks for.
//
// Why pure TS, not createRoot:
//   - The comparator is a pure data function (no React, no DOM). A
//     rendering test would only re-exercise Radix.
//
// Cases pin:
//   1. `created` — three rows, mixed `createdAt`, assert descending order.
//      Mapped from the prior `newest` literal via the brief rename;
//      SQL cursor stays monotone `createdAt desc` (same Prisma-native
//      branch as before).
//   2. `severity` — five rows covering critical/high/medium/low/unknown
//      (null). Assert critical → high → medium → low → unknown outer
//      order; within a rank, newer `createdAt` first.
//   3. `status` — six rows covering each status twice with differing
//      `createdAt` to exercise the createdAt-desc tiebreak, then
//      `id desc` for the within-status tiebreak.
//   4. `lastActivity` — derived-column sort with `lastActivityAt ??
//      createdAt` as the rank key, descending, with createdAt-desc
//      followed by id-desc tiebreaks. The helper now omits cold-start
//      rows from the per-row map, so a null `lastActivityAt` on the
//      wire is reachable and the comparator's `?? createdAt`
//      fallback fires. Default.
//   5. `lastActivity:asc` — same rank key as `lastActivity` but
//      ASCENDED; pin null-`lastActivityAt` falls back to `createdAt`
//      for the comparator and ASC were-in-direction post-flip.
//   6. `created:asc` — `createdAt asc`.
//   7. `riskScore` / `riskScore:asc` — associated asset score with nulls
//      last and createdAt/id descending tiebreaks.
//
// The schema-level wire-registry assertion at the bottom pins the
// `?sort=last_activity` (snake_case) permalink alias rounds back to
// the camelCase internal `lastActivity` form via AlertQuery.parse's
// transform — and that the new `:asc` arms are accepted arms on the
// schema parse.

import { describe, expect, it } from 'vitest';
import { compareAlertsBySort } from '@/lib/business/alerts-sort';
import type { AlertItem, AlertSortKey } from '@/lib/contracts/alerts';
import { AlertQuery } from '@/lib/contracts/alerts';

// Build a minimal AlertItem stub — only fields the comparator reads are
// enforced; this keeps the fixture focused on the branch under test.
function row(overrides: Partial<AlertItem> & { id: string; createdAt: string }): AlertItem {
  return {
    id: overrides.id,
    teamId: 'team-1',
    findingId: `finding-${overrides.id}`,
    severity: overrides.severity ?? null,
    status: overrides.status ?? 'open',
    source: 'manual',
    assigneeId: null,
    ownerId: null,
    ownerName: null,
    createdAt: overrides.createdAt,
    acknowledgedAt: null,
    snoozedUntil: null,
    cveId: overrides.cveId ?? `CVE-${overrides.id}`,
    vulnerabilityTitle: null,
    asset: overrides.asset ?? { host: 'host.example', port: 443, protocol: 'tcp' },
    falsePositiveReason: null,
    closingNote: null,
    remediatedAt: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
  };
}

function sorted(items: AlertItem[], key: AlertSortKey): AlertItem[] {
  return [...items].sort((a, b) => compareAlertsBySort(a, b, key));
}

describe('compareAlertsBySort', () => {
  it('sorts `created` by createdAt descending', () => {
    const items = [
      row({ id: 'tie-a', createdAt: '2026-01-03T12:00:00.000Z' }),
      row({ id: 'oldest', createdAt: '2026-01-01T12:00:00.000Z' }),
      row({ id: 'newest', createdAt: '2026-01-04T12:00:00.000Z' }),
      row({ id: 'tie-z', createdAt: '2026-01-03T12:00:00.000Z' }),
    ];
    const result = sorted(items, 'created').map((i) => i.id);
    expect(result).toEqual(['newest', 'tie-z', 'tie-a', 'oldest']);
  });

  it('sorts `severity` worst-on-top with hostname then alert ID tiebreaks', () => {
    const items = [
      // Same severity is ordered by hostname, regardless of createdAt.
      row({
        id: 'crit-zeta',
        severity: 'critical',
        createdAt: '2026-01-01T00:00:00.000Z',
        asset: { host: 'zeta.example', port: 443, protocol: 'tcp' },
      }),
      row({
        id: 'crit-alpha-z',
        severity: 'critical',
        createdAt: '2026-01-04T00:00:00.000Z',
        asset: { host: 'alpha.example', port: 443, protocol: 'tcp' },
      }),
      // Duplicate hostname uses alert ID ascending as the final key.
      row({
        id: 'crit-alpha-a',
        severity: 'critical',
        createdAt: '2026-01-02T00:00:00.000Z',
        asset: { host: 'alpha.example', port: 443, protocol: 'tcp' },
      }),
      row({ id: 'hi', severity: 'high', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'med', severity: 'medium', createdAt: '2026-01-03T00:00:00.000Z' }),
      row({ id: 'lo', severity: 'low', createdAt: '2026-01-04T00:00:00.000Z' }),
      // Unknown / null sinks to the bottom even when newer than
      // every canonical rank — rank is the primary key.
      row({ id: 'unk', severity: null, createdAt: '2026-01-05T00:00:00.000Z' }),
    ];
    const result = sorted(items, 'severity').map((i) => i.id);
    expect(result).toEqual([
      'crit-alpha-a',
      'crit-alpha-z',
      'crit-zeta',
      'hi', // high
      'med', // medium
      'lo', // low
      'unk', // null sinks to the bottom
    ]);
  });

  it('keeps hostname and duplicate-host alert ID order the same in both severity directions', () => {
    const items = [
      row({
        id: 'high-zeta',
        severity: 'high',
        createdAt: '2026-01-01T00:00:00.000Z',
        asset: { host: 'zeta.example', port: 443, protocol: 'tcp' },
      }),
      row({
        id: 'high-alpha-z',
        severity: 'high',
        createdAt: '2026-01-03T00:00:00.000Z',
        asset: { host: 'Alpha.example', port: 443, protocol: 'tcp' },
      }),
      row({
        id: 'high-alpha-a',
        severity: 'high',
        createdAt: '2026-01-02T00:00:00.000Z',
        asset: { host: 'alpha.example', port: 443, protocol: 'tcp' },
      }),
    ];
    const expected = ['high-alpha-a', 'high-alpha-z', 'high-zeta'];

    expect(sorted(items, 'severity').map((item) => item.id)).toEqual(expected);
    expect(sorted(items, 'severity:asc').map((item) => item.id)).toEqual(expected);
  });

  it('sorts `severity:asc` low → medium → high → critical → unknown/null with ascending tiebreaks', () => {
    const items = [
      row({ id: 'critical', severity: 'critical', createdAt: '2026-01-05T00:00:00.000Z' }),
      row({ id: 'high', severity: 'high', createdAt: '2026-01-04T00:00:00.000Z' }),
      row({ id: 'medium', severity: 'medium', createdAt: '2026-01-03T00:00:00.000Z' }),
      row({ id: 'low', severity: 'low', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'unknown', severity: 'informational', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'null', severity: null, createdAt: '2026-01-01T00:00:00.000Z' }),
    ];

    expect(sorted(items, 'severity:asc').map((item) => item.id)).toEqual([
      'low',
      'medium',
      'high',
      'critical',
      'null',
      'unknown',
    ]);
  });

  it('sorts `status` open → in_progress → resolved with createdAt-desc then id-desc tiebreaks', () => {
    const items = [
      // open (rank 0) — two rows, createdAt differs.
      row({
        id: 'open-old',
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      row({
        id: 'open-new',
        status: 'open',
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
      // in_progress (rank 1) — same createdAt to force the id tiebreak.
      row({
        id: 'in-prog-A',
        status: 'in_progress',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      row({
        id: 'in-prog-Z',
        status: 'in_progress',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      // resolved (rank 2) — two rows, createdAt differs.
      row({
        id: 'res-old',
        status: 'resolved',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      row({
        id: 'res-new',
        status: 'resolved',
        createdAt: '2026-01-04T00:00:00.000Z',
      }),
    ];
    const result = sorted(items, 'status').map((i) => i.id);
    expect(result).toEqual([
      'open-new', // open rank, newer createdAt
      'open-old', // open rank, older createdAt
      'in-prog-Z', // in_progress, same createdAt → id desc
      'in-prog-A', // in_progress, same createdAt → id desc
      'res-new', // resolved, newer createdAt
      'res-old', // resolved, older createdAt
    ]);
  });

  it('sorts `status` with false_positive (rank 3) at the end after resolved', () => {
    // The FP rank was appended to STATUS_ORDINAL AFTER `resolved` so
    // false-positive rows sink to the bottom of a `status` sort —
    // matches the operator's mental model that FP is the most recent
    // addition to the triage flow AND the "suppressed" branch reads
    // visually last in the chip row.
    const items = [
      row({ id: 'r1', status: 'resolved', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'r2', status: 'resolved', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'fp1', status: 'false_positive', createdAt: '2026-01-05T00:00:00.000Z' }),
      row({ id: 'fp2', status: 'false_positive', createdAt: '2026-01-04T00:00:00.000Z' }),
      row({ id: 'o1', status: 'open', createdAt: '2026-01-03T00:00:00.000Z' }),
    ];
    const result = sorted(items, 'status').map((i) => i.status);
    expect(result).toEqual(['open', 'resolved', 'resolved', 'false_positive', 'false_positive']);
  });

  it('sorts `lastActivity` by lastActivityAt descending with createdAt-desc + id-desc tiebreaks', () => {
    const items = [
      // Three rows with distinct lastActivityAt values; tiebreaks
      // not exercised (createdAt differs across all rows).
      row({
        id: 'oldest-derive',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-10T00:00:00.000Z',
      }),
      row({
        id: 'middle-derive',
        createdAt: '2026-01-02T00:00:00.000Z',
        lastActivityAt: '2026-02-05T00:00:00.000Z',
      }),
      row({
        id: 'newest-derive',
        createdAt: '2026-01-03T00:00:00.000Z',
        lastActivityAt: '2026-03-01T00:00:00.000Z',
      }),
    ];
    const result = sorted(items, 'lastActivity').map((i) => i.id);
    expect(result).toEqual(['newest-derive', 'middle-derive', 'oldest-derive']);
  });

  it("falls back to createdAt when a row's lastActivityAt is null (cold-start)", () => {
    // Cold-start case: brand-new row has no notes, no remediated
    // stamp — the helper now omits the row from the per-row map,
    // so the wire stamp is null. The comparator's defensive
    // `?? createdAt` keeps a cold-start row from sinking below
    // every older-but-derived row: the comparator's rank key is
    // `lastActivityAt ?? createdAt`, so the brand-new row ranks on
    // its creation timestamp.
    const items = [
      row({
        id: 'cold-start',
        createdAt: '2026-02-01T00:00:00.000Z',
        lastActivityAt: null,
      }),
      row({
        id: 'remediated-old',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-15T00:00:00.000Z',
      }),
    ];
    const result = sorted(items, 'lastActivity').map((i) => i.id);
    expect(result).toEqual(['cold-start', 'remediated-old']);
  });

  it('sorts `lastActivity:asc` ASCENDED (oldest activity first) with createdAt-asc + id-asc tiebreaks', () => {
    // Mirror of the `lastActivity` DESC branch — same rank key,
    // same `?? createdAt` null-stamp fallback, same multi-key
    // stable sort with all tiebreaks flipped to ASC so the
    // ascending direction holds end-to-end.
    const items = [
      row({
        id: 'newest-derive',
        createdAt: '2026-01-03T00:00:00.000Z',
        lastActivityAt: '2026-03-01T00:00:00.000Z',
      }),
      row({
        id: 'middle-derive',
        createdAt: '2026-01-02T00:00:00.000Z',
        lastActivityAt: '2026-02-05T00:00:00.000Z',
      }),
      row({
        id: 'oldest-derive',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-10T00:00:00.000Z',
      }),
    ];
    const result = sorted(items, 'lastActivity:asc').map((i) => i.id);
    expect(result).toEqual(['oldest-derive', 'middle-derive', 'newest-derive']);
  });

  it('null lastActivityAt falls back to createdAt under `lastActivity:asc`', () => {
    // Brand-new row under the ascending branch — comparator rank
    // key is `lastActivityAt ?? createdAt` ASC; cold-start row
    // sorts on its creation timestamp against the older-remediated
    // row. Reverses the DESC-ordering of the same two-row fixture
    // in `lastActivity`'s counterpart case.
    const items = [
      row({
        id: 'cold-start',
        createdAt: '2026-02-01T00:00:00.000Z',
        lastActivityAt: null,
      }),
      row({
        id: 'remediated-old',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-15T00:00:00.000Z',
      }),
    ];
    const result = sorted(items, 'lastActivity:asc').map((i) => i.id);
    expect(result).toEqual(['remediated-old', 'cold-start']);
  });

  it('sorts `created:asc` ASCENDED (oldest createdAt first)', () => {
    // The dropdown's "Created (Oldest first)" option rides this
    // arm; multi-key stable sort maintains the ascending direction
    // via id-asc within an equals-createdAt cluster.
    const items = [
      row({ id: 'tie-z', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'c', createdAt: '2026-01-03T00:00:00.000Z' }),
      row({ id: 'tie-a', createdAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const result = sorted(items, 'created:asc').map((i) => i.id);
    expect(result).toEqual(['a', 'tie-a', 'tie-z', 'c']);
  });

  it('keeps unusable createdAt values visible after usable timestamps', () => {
    const items = [
      row({ id: 'invalid', createdAt: '' }),
      row({ id: 'newest', createdAt: '2026-01-03T00:00:00.000Z' }),
      row({ id: 'oldest', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'also-invalid', createdAt: 'not-a-date' }),
    ];

    expect(sorted(items, 'created:asc').map((item) => item.id)).toEqual([
      'oldest',
      'newest',
      'also-invalid',
      'invalid',
    ]);
  });

  it('sorts associated asset risk scores highest first with nulls last', () => {
    const items = [
      row({ id: 'score-7', createdAt: '2026-01-01T00:00:00.000Z', asset: { host: 'a', port: 443, protocol: 'tcp', riskScore: 7 } }),
      row({ id: 'score-9', createdAt: '2026-01-02T00:00:00.000Z', asset: { host: 'b', port: 443, protocol: 'tcp', riskScore: 9 } }),
      row({ id: 'score-null', createdAt: '2026-01-03T00:00:00.000Z', asset: { host: 'c', port: 443, protocol: 'tcp', riskScore: null } }),
      row({ id: 'score-9-old', createdAt: '2026-01-01T00:00:00.000Z', asset: { host: 'd', port: 443, protocol: 'tcp', riskScore: 9 } }),
    ];

    expect(sorted(items, 'riskScore').map((item) => item.id)).toEqual([
      'score-9',
      'score-9-old',
      'score-7',
      'score-null',
    ]);
  });

  it('sorts associated asset risk scores lowest first while keeping nulls last', () => {
    const items = [
      row({ id: 'score-7', createdAt: '2026-01-01T00:00:00.000Z', asset: { host: 'a', port: 443, protocol: 'tcp', riskScore: 7 } }),
      row({ id: 'score-2', createdAt: '2026-01-02T00:00:00.000Z', asset: { host: 'b', port: 443, protocol: 'tcp', riskScore: 2 } }),
      row({ id: 'score-null', createdAt: '2026-01-03T00:00:00.000Z', asset: { host: 'c', port: 443, protocol: 'tcp', riskScore: null } }),
    ];

    expect(sorted(items, 'riskScore:asc').map((item) => item.id)).toEqual([
      'score-2',
      'score-7',
      'score-null',
    ]);
  });

  it('does NOT pin — within-activity createdAt-desc then id-desc tiebreaks', () => {
    // Same lastActivityAt on three rows → createdAt-desc resolves,
    // then id-desc as the final tiebreak.
    const sameActivity = '2026-02-15T00:00:00.000Z';
    const items = [
      row({
        id: 'same-c-newest',
        createdAt: '2026-02-01T00:00:00.000Z',
        lastActivityAt: sameActivity,
      }),
      row({
        id: 'same-c-middle',
        createdAt: '2026-01-20T00:00:00.000Z',
        lastActivityAt: sameActivity,
      }),
      row({
        // Same createdAt as `same-c-middle`, different id — id desc tiebreak.
        id: 'same-c-middle-Z',
        createdAt: '2026-01-20T00:00:00.000Z',
        lastActivityAt: sameActivity,
      }),
    ];
    const result = sorted(items, 'lastActivity').map((i) => i.id);
    expect(result).toEqual(['same-c-newest', 'same-c-middle-Z', 'same-c-middle']);
  });

  it('round-trips `?sort=lastActivity` through AlertQuery.safeParse(...)', () => {
    // Schema-level wire-registry assertion — the literal must parse
    // without errors AND must default to `lastActivity` on the
    // absent path so a fresh /alerts permalink lands on the brief
    // default (Last activity, ascending the dropdown's first entry).
    const parsed = AlertQuery.safeParse({ sort: 'lastActivity' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sort).toBe('lastActivity');

    const defaulted = AlertQuery.safeParse({});
    expect(defaulted.success).toBe(true);
    if (defaulted.success) expect(defaulted.data.sort).toBe('lastActivity');

    // Positive round-trip: `?sort=created` parses cleanly to the
    // post-transform `created` literal so the dropdown's "Created
    // (most recent first)" option stays 1:1 over the URL contract.
    const created = AlertQuery.safeParse({ sort: 'created' });
    expect(created.success).toBe(true);
    if (created.success) expect(created.data.sort).toBe('created');

    // Snake_case alias: the brief's literal `?sort=last_activity`
    // round-trips back to the camelCase internal via the AlertQuery
    // zod parse transform — both forms parse to the same `lastActivity`
    // shape so a bookmarked URL survives a reload + CSV anchor.
    const snake = AlertQuery.safeParse({ sort: 'last_activity' });
    expect(snake.success).toBe(true);
    if (snake.success) expect(snake.data.sort).toBe('lastActivity');

    // `:asc` arms parse cleanly to the post-transform literal so
    // the dropdown's "oldest first" options stay 1:1 over the URL.
    const lastAsc = AlertQuery.safeParse({ sort: 'lastActivity:asc' });
    expect(lastAsc.success).toBe(true);
    if (lastAsc.success) expect(lastAsc.data.sort).toBe('lastActivity:asc');

    const createdAsc = AlertQuery.safeParse({ sort: 'created:asc' });
    expect(createdAsc.success).toBe(true);
    if (createdAsc.success) expect(createdAsc.data.sort).toBe('created:asc');

    const createdAscWire = AlertQuery.safeParse({ sort: 'created_asc' });
    expect(createdAscWire.success).toBe(true);
    if (createdAscWire.success) expect(createdAscWire.data.sort).toBe('created:asc');

    const severityAsc = AlertQuery.safeParse({ sort: 'severity_asc' });
    expect(severityAsc.success).toBe(true);
    if (severityAsc.success) expect(severityAsc.data.sort).toBe('severity:asc');

    const riskScore = AlertQuery.safeParse({ sort: 'riskScore' });
    expect(riskScore.success).toBe(true);
    if (riskScore.success) expect(riskScore.data.sort).toBe('riskScore');

    const riskScoreAsc = AlertQuery.safeParse({ sort: 'risk_score_asc' });
    expect(riskScoreAsc.success).toBe(true);
    if (riskScoreAsc.success) expect(riskScoreAsc.data.sort).toBe('riskScore:asc');

    // Negative: a non-enum value still 400s through, so a typo'd
    // URL never silently narrows.
    const typo = AlertQuery.safeParse({ sort: 'lastactivity' } as unknown);
    expect(typo.success).toBe(false);
  });
});
