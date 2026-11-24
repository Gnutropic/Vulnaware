// Brief case #2 — URL round-trip test for the trailing-days chip +
// buildEffectiveQs writer. Pure Node test (no React, no DB).
// Locks the URL contract:
//   - since: '7d' → output contains `since=7d`
//   - since: null → output strips the key entirely
//   - composes with severity, status, ownedByMe, q, from, to
//   - selection rides alongside as it already does
//   - ownedByMe: true → output contains `ownedByMe=1`
//   - ownedByMe: false (default) → output strips the key entirely
//   - severity multi-select Set: null strips the key; empty Set
//     strips the key; a single-element Set emits `severity=<lit>`
//     (subsumes the legacy single-literal permalink); a
//     multi-element Set emits the canonical critical → high →
//     medium → low CSV via `formatSeverityFilter` (input order is
//     irrelevant).

import { describe, expect, it } from 'vitest';
import {
  buildAlertPageHref,
  buildEffectiveQs,
  parseAlertWorkflowStatus,
  type EffectiveQsInput,
} from '@/lib/business/alerts-effective-qs';
import { parseSeverityFilter, type SeverityLiteral } from '@/lib/business/alerts-severity';
import { AlertQuery } from '@/lib/contracts/alerts';

function defaults(): EffectiveQsInput {
  return {
    severity: null,
    status: null,
    triggeredBy: null,
    hideSnoozed: false,
    highRiskAssets: false,
    ownedByMe: false,
    remediatedOnly: false,
    snoozedOnly: false,
    openOnly: false,
    resolvedOnly: false,
    sort: 'lastActivity',
    since: null,
    asset: null,
  };
}

// Helper — parse a `?...` query string back through URLSearchParams
// so a comma-encoded value decodes correctly. The writer always emits
// via URLSearchParams.toString(), which percent-encodes any non-ASCII
// or reserved character; assertions below compare the decoded value,
// which is what the browser actually parses.
function parseOut(out: string): URLSearchParams {
  return new URLSearchParams(out.startsWith('?') ? out.slice(1) : out);
}

describe('buildEffectiveQs — resolution URL round-trip', () => {
  it.each(['all', 'unresolved', 'resolved'] as const)('emits resolution=%s', (resolution) => {
    const out = buildEffectiveQs(
      { ...defaults(), resolution },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('resolution')).toBe(resolution);
  });

  it('composes resolution with search, severity, status, and sorting', () => {
    const incoming = new URLSearchParams(
      'q=log4j&hostname=api.example&from=2026-07-01&to=2026-07-23',
    );
    const out = buildEffectiveQs(
      {
        ...defaults(),
        resolution: 'resolved',
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        sort: 'severity',
      },
      incoming,
      new Set(),
    );
    const params = parseOut(out);
    expect(params.get('resolution')).toBe('resolved');
    expect(params.get('severity')).toBe('high');
    expect(params.get('status')).toBe('in_progress');
    expect(params.get('sort')).toBe('severity');
    expect(params.get('q')).toBe('log4j');
    expect(params.get('hostname')).toBe('api.example');
    expect(params.get('from')).toBe('2026-07-01');
    expect(params.get('to')).toBe('2026-07-23');
  });
});

describe('alert pagination URL state', () => {
  it('changes only the page while preserving the active filters and search state', () => {
    const current =
      '?page=2&pageSize=25&q=log4j&status=in_progress&hostname=api.example&from=2026-07-01&to=2026-07-23&severity=critical,high&sort=created&source=kev&asset=api.example:443/tcp';

    const next = new URLSearchParams(buildAlertPageHref(current, 3).split('?')[1]);
    expect(next.get('page')).toBe('3');
    expect(next.get('pageSize')).toBe('25');
    expect(next.get('q')).toBe('log4j');
    expect(next.get('status')).toBe('in_progress');
    expect(next.get('hostname')).toBe('api.example');
    expect(next.get('from')).toBe('2026-07-01');
    expect(next.get('to')).toBe('2026-07-23');
    expect(next.get('severity')).toBe('critical,high');
    expect(next.get('sort')).toBe('created');
    expect(next.get('source')).toBe('kev');
    expect(next.get('asset')).toBe('api.example:443/tcp');

    const first = new URLSearchParams(buildAlertPageHref(current, 1).split('?')[1]);
    expect(first.has('page')).toBe(false);
    expect(first.get('q')).toBe('log4j');
    expect(first.get('from')).toBe('2026-07-01');
    expect(first.get('to')).toBe('2026-07-23');
  });
});

describe('buildEffectiveQs — severity URL round-trip (multi-select)', () => {
  // Brief: ?severity= is multi-select composable, emits the canonical
  // critical → high → medium → low CSV via `formatSeverityFilter`
  // regardless of input order, and strips the key on a null / empty
  // Set (the resting state). Mirror of the asset round-trip block
  // below.

  it('null severity strips the severity key', () => {
    const out = buildEffectiveQs(
      { ...defaults(), severity: null },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).not.toContain('severity=');
  });

  it('empty Set severity strips the severity key', () => {
    // The chip row collapses an empty Set → `null` on its own (the
    // "click last tier off" gesture), but a defensive writer contract
    // also treats an empty Set the same way — both states emit no
    // `?severity=` key. Pins the no-key-leak shape on either input.
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>() },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).not.toContain('severity=');
  });

  it('single-element Set{critical} emits severity=critical (subsumes the dashboard-tile deep-link)', () => {
    // The single-literal permalink from /dashboard's
    // DashboardOpenBySeverity tile → `/alerts?status=open&severity=
    // critical` lands at the page's `parseFiltersFromParams` as
    // `severity: Set{critical}` (via `parseSeverityFilter`'s 1-length
    // CSV parse), and the writer emits `severity=critical` (no
    // trailing comma).
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>(['critical']) },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('critical');
  });

  it.each(['critical', 'high', 'medium', 'low'])(
    'single-element Set{%s} emits severity=%s in the query string',
    (lvl) => {
      const out = buildEffectiveQs(
        { ...defaults(), severity: new Set<SeverityLiteral>([lvl as SeverityLiteral]) },
        new URLSearchParams(),
        new Set(),
      );
      expect(parseOut(out).get('severity')).toBe(lvl);
    },
  );

  it('Set{critical, high} emits canonical severity=critical,high', () => {
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>(['critical', 'high']) },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('critical,high');
  });

  it('round-trips arbitrary stored severity values without mapping them to a standard bucket', () => {
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>(['legacy-value']) },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('legacy-value');
  });

  it('Set{low, critical, medium} (input-order scrambled) emits canonical severity=critical,medium,low', () => {
    // Mirror of the asset round-trip "non-canonical order" case:
    // the writer sorts via `SEVERITY_RANK` regardless of Set
    // iteration order, so a permalink stays stable. Click sequence
    // ordering is NOT a wire invariant — only canonical ranking
    // is. The Set here intentionally omits `high` so the canonical
    // emission is `critical,medium,low` (NOT the full rank) — a
    // regression guard against a future writer that silently
    // pads missing ranks.
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['low', 'critical', 'medium']),
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('critical,medium,low');
  });

  it('Set{critical, high, medium, low} emits the full canonical CSV verbatim', () => {
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['critical', 'high', 'medium', 'low']),
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('critical,high,medium,low');
  });

  it('Severity multi-value Set composes with status/ownedByMe/q/from/to/selected', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('hostname', 'api.example');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['critical', 'high']),
        status: 'in_progress',
        ownedByMe: true,
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    const sp = parseOut(out);
    expect(sp.get('severity')).toBe('critical,high');
    expect(sp.get('status')).toBe('in_progress');
    expect(sp.get('ownedByMe')).toBe('1');
    expect(sp.get('q')).toBe('log4j');
    expect(sp.get('hostname')).toBe('api.example');
    expect(sp.get('from')).toBe('2026-07-01');
    expect(sp.get('to')).toBe('2026-07-23');
    expect(sp.get('selected')).toBe('alert-1,alert-2');
  });

  it('severity selection and clearing preserve page, page size, status, hostname, and sort', () => {
    const incoming = new URLSearchParams(
      'hostname=api.example&status=in_progress&sort=created_asc&page=3&pageSize=10',
    );
    const selected = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        sort: 'created:asc',
      },
      incoming,
      new Set(),
    );
    const selectedParams = parseOut(selected);
    expect(selectedParams.get('severity')).toBe('high');
    expect(selectedParams.get('status')).toBe('in_progress');
    expect(selectedParams.get('hostname')).toBe('api.example');
    expect(selectedParams.get('sort')).toBe('created_asc');
    expect(selectedParams.get('page')).toBe('3');
    expect(selectedParams.get('pageSize')).toBe('10');

    const cleared = buildEffectiveQs(
      {
        ...defaults(),
        severity: null,
        status: 'in_progress',
        sort: 'created:asc',
      },
      incoming,
      new Set(),
    );
    const clearedParams = parseOut(cleared);
    expect(clearedParams.has('severity')).toBe(false);
    expect(clearedParams.get('status')).toBe('in_progress');
    expect(clearedParams.get('hostname')).toBe('api.example');
    expect(clearedParams.get('sort')).toBe('created_asc');
    expect(clearedParams.get('page')).toBe('3');
    expect(clearedParams.get('pageSize')).toBe('10');
  });

  it('permalink ?severity=critical,high round-trips: page parses BOTH literals into the Set, writer emits both', () => {
    // Mirror the page lazy-initializer: `parseSeverityFilter('critical,
    // high')` returns `['critical', 'high']`; the page's
    // `parseFiltersFromParams` builds `new Set(severityArr)` (no
    // collapse). The writer then reads that Set,
    // `formatSeverityFilter` returns `'critical,high'` (canonical
    // already), and the URL round-trips byte-for-byte. Regression
    // guard for the brief's "legacy multi-value CSV permalink lands
    // on BOTH chips lit" criterion.
    const incoming = new URLSearchParams();
    incoming.set('severity', 'critical,high');
    const parsedArr = parseSeverityFilter(incoming.get('severity'));
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>(parsedArr) },
      incoming,
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('critical,high');
  });

  it('permalink ?severity=high,critical (non-canonical input order) round-trips into canonical', () => {
    // Mirror: `parseSeverityFilter` preserves INPUT order but the
    // writer sorts via `SEVERITY_RANK`; either way `?severity=
    // high,critical` lands on the canonical `critical,high` after
    // a chip click writes the URL. This is the lockstep with the
    // asset row's alphabetical sort.
    const incoming = new URLSearchParams();
    incoming.set('severity', 'high,critical');
    const parsedArr = parseSeverityFilter(incoming.get('severity'));
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>(parsedArr) },
      incoming,
      new Set(),
    );
    expect(parseOut(out).get('severity')).toBe('critical,high');
  });

  it('severity Set composes with since + status + ownedByMe + selected (regression guard)', () => {
    // Regression guard: the brief's "every other chip rides alongside
    // severity" guarantee. A future writer refactor that drops
    // `severity` when other keys are present would silently strip
    // the visible filter band on a combined view. The composition
    // assertion pins the ride-along contract on every chip + q +
    // from + to + selected + since.
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['low']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=low');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('remediated=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
  });

  it('severity ascending preserves the full filter, search, date, and selection state', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('hostname', 'api.example');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    incoming.set('source', 'kev');
    incoming.set('acknowledged', 'true');
    incoming.set('assigneeReady', 'true');
    incoming.set('page', '3');
    incoming.set('pageSize', '25');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['critical', 'low']),
        status: 'resolved',
        triggeredBy: 'scheduled',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: true,
        snoozedOnly: true,
        sort: 'severity:asc',
        since: '7d',
        asset: new Set(['example.com:443/tcp']),
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    const parsed = parseOut(out);

    expect(parsed.get('sort')).toBe('severity_asc');
    expect(parsed.get('severity')).toBe('critical,low');
    expect(parsed.get('status')).toBe('resolved');
    expect(parsed.get('triggeredBy')).toBe('scheduled');
    expect(parsed.get('hideSnoozed')).toBe('1');
    expect(parsed.get('ownedByMe')).toBe('1');
    expect(parsed.get('remediated')).toBe('1');
    expect(parsed.get('snoozed')).toBe('1');
    expect(parsed.get('asset')).toBe('example.com:443/tcp');
    expect(parsed.get('source')).toBe('kev');
    expect(parsed.get('acknowledged')).toBe('true');
    expect(parsed.get('assigneeReady')).toBe('true');
    expect(parsed.get('since')).toBe('7d');
    expect(parsed.get('q')).toBe('log4j');
    expect(parsed.get('hostname')).toBe('api.example');
    expect(parsed.get('from')).toBe('2026-07-01');
    expect(parsed.get('to')).toBe('2026-07-23');
    expect(parsed.get('page')).toBe('3');
    expect(parsed.get('pageSize')).toBe('25');
    expect(parsed.get('selected')).toBe('alert-1,alert-2');

    const restored = AlertQuery.parse(Object.fromEntries(parsed.entries()));
    expect(restored.sort).toBe('severity:asc');
    expect(restored.page).toBe(3);
    expect(restored.pageSize).toBe(25);
  });

  it('selection rides alongside severity Set (bulk-action working set is independent)', () => {
    // The bulk-action working set (selection) rides its own URL key
    // (`?selected=`) — it is NOT cleared by any chip flip. This test
    // mirrors the existing selection-on-every-chip cases but pins that
    // the multi-select severity chip + a populated selection compose
    // without overlap (a future refactor that silently aliases either
    // side would break the "1:1 visible-row guarantee" the CSV
    // export pins).
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    const out = buildEffectiveQs(
      { ...defaults(), severity: new Set<SeverityLiteral>(['medium']) },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=medium');
    expect(out).toContain('selected=');
    expect(out).toContain('q=log4j');
  });

  it('severity set + asset set + every other key compose without duplication of `severity=`', () => {
    // Sister to the asset round-trip companion at line 697 in the
    // original file — every wire key rides alongside severity in
    // its canonical form. `URLSearchParams.set` is single-write
    // (replaces); a refactor that switches to `.append` would
    // silently duplicate the key on a re-emission, so we pin
    // exactly one occurrence.
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high', 'low']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: true,
        snoozedOnly: true,
        openOnly: false,
        sort: 'severity',
        since: '7d',
        asset: new Set(['example.com:443/tcp', 'vpn.example.com:80/udp']),
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    // Compare via the parsed query (URLSearchParams encodes `,` as
    // `%2C` on `.toString()`), so a substring `toContain` would
    // flake. The decoded `get('severity')` is the wire shape the
    // page + route actually read.
    const parsed = parseOut(out);
    expect(parsed.get('severity')).toBe('high,low');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('remediated=1');
    expect(out).toContain('snoozed=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    expect(parsed.get('asset')).toBe('example.com:443/tcp,vpn.example.com:80/udp');
    // Negative shape: no `severity=` duplication (single-write only).
    const severityMatches = out.match(/severity=/g) ?? [];
    expect(severityMatches.length).toBe(1);
  });
});

describe('buildEffectiveQs — since URL round-trip', () => {
  it('since="7d" emits since=7d in the query string', () => {
    const out = buildEffectiveQs({ ...defaults(), since: '7d' }, new URLSearchParams(), new Set());
    expect(out).toContain('since=7d');
  });

  it('since=null strips the key from the query string', () => {
    const out = buildEffectiveQs({ ...defaults() }, new URLSearchParams(), new Set());
    expect(out).not.toContain('since=');
  });

  it('composes since=7d with severity + status + ownedByMe + q + from', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'foo');
    incoming.set('from', '2026-01-01');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['critical']),
        status: 'in_progress',
        ownedByMe: true,
        since: '7d',
      },
      incoming,
      new Set(),
    );
    expect(out).toContain('severity=critical');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=foo');
    expect(out).toContain('from=2026-01-01');
  });

  it('emits the default sort when no filters are set', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).toBe('?sort=last_activity');
  });

  it('preserves incoming q/from/to even when chip state is null', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-01-01');
    incoming.set('to', '2026-07-01');
    const out = buildEffectiveQs(defaults(), incoming, new Set());
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-01-01');
    expect(out).toContain('to=2026-07-01');
  });

  it("emits sort key in the brief's snake_case wire form for every arm", () => {
    // The writer emits the brief-friendly snake_case form: rest
    // default `lastActivity` → `last_activity`; ASC arms →
    // `_asc` suffix; `created` and `severity` / `status` ride
    // verbatim (the existing camelCase wire shape stays so the
    // legacy `?sort=newest` permalink's `created` literal
    // round-trips cleanly). URL cycle stays byte-stable across a
    // reload + CSV anchor.
    const defLastActivity = buildEffectiveQs(
      { ...defaults(), sort: 'lastActivity' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defLastActivity).get('sort')).toBe('last_activity');

    const defLastActivityAsc = buildEffectiveQs(
      { ...defaults(), sort: 'lastActivity:asc' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defLastActivityAsc).get('sort')).toBe('last_activity_asc');

    const defSeverity = buildEffectiveQs(
      { ...defaults(), sort: 'severity' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defSeverity).get('sort')).toBe('severity');

    const defSeverityAsc = buildEffectiveQs(
      { ...defaults(), sort: 'severity:asc' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defSeverityAsc).get('sort')).toBe('severity_asc');

    const defCreated = buildEffectiveQs(
      { ...defaults(), sort: 'created' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defCreated).get('sort')).toBe('created');

    const defCreatedAsc = buildEffectiveQs(
      { ...defaults(), sort: 'created:asc' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defCreatedAsc).get('sort')).toBe('created_asc');

    const defStatus = buildEffectiveQs(
      { ...defaults(), sort: 'status' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defStatus).get('sort')).toBe('status');

    const defRiskScore = buildEffectiveQs(
      { ...defaults(), sort: 'riskScore' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defRiskScore).get('sort')).toBe('riskScore');

    const defRiskScoreAsc = buildEffectiveQs(
      { ...defaults(), sort: 'riskScore:asc' },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(defRiskScoreAsc).get('sort')).toBe('riskScore:asc');
  });

  it('preserves both asset risk-score sort values with active filters', () => {
    const incoming = new URLSearchParams('q=log4j&from=2026-01-01&to=2026-07-01');
    for (const sort of ['riskScore', 'riskScore:asc'] as const) {
      const out = buildEffectiveQs(
        {
          ...defaults(),
          severity: new Set<SeverityLiteral>(['high']),
          status: 'in_progress',
          ownedByMe: true,
          sort,
          since: '7d',
        },
        incoming,
        new Set(['alert-1']),
      );
      const params = parseOut(out);
      expect(params.get('sort')).toBe(sort);
      expect(params.get('severity')).toBe('high');
      expect(params.get('status')).toBe('in_progress');
      expect(params.get('q')).toBe('log4j');
      expect(params.get('from')).toBe('2026-01-01');
      expect(params.get('to')).toBe('2026-07-01');
      expect(params.get('selected')).toBe('alert-1');
    }
  });

  it('drops selected= when the bulk-resolve working set is empty', () => {
    const empty = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(empty).not.toContain('selected=');
  });

  it('keeps selected= when the working set has ids', () => {
    const withSelected = buildEffectiveQs(
      defaults(),
      new URLSearchParams(),
      new Set(['alert-1', 'alert-2']),
    );
    expect(withSelected).toContain('selected=');
  });
});

describe('buildEffectiveQs — highRiskAssets URL round-trip', () => {
  it('emits highRiskAssets=1 when enabled', () => {
    const out = buildEffectiveQs(
      { ...defaults(), highRiskAssets: true },
      new URLSearchParams(),
      new Set(),
    );

    expect(parseOut(out).get('highRiskAssets')).toBe('1');
  });

  it('removes only highRiskAssets while preserving search, severity, sort, and selection', () => {
    const incoming = new URLSearchParams(
      'highRiskAssets=1&q=log4j&from=2026-07-01&to=2026-07-23',
    );
    const out = buildEffectiveQs(
      {
        ...defaults(),
        highRiskAssets: false,
        severity: new Set<SeverityLiteral>(['critical', 'high']),
        sort: 'severity',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    const params = parseOut(out);

    expect(params.get('highRiskAssets')).toBeNull();
    expect(params.get('q')).toBe('log4j');
    expect(params.get('severity')).toBe('critical,high');
    expect(params.get('sort')).toBe('severity');
    expect(params.get('selected')).toBe('alert-1,alert-2');
    expect(params.get('from')).toBe('2026-07-01');
    expect(params.get('to')).toBe('2026-07-23');
  });
});

describe('buildEffectiveQs — ownedByMe URL round-trip', () => {
  it('ownedByMe=true emits ownedByMe=1 in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), ownedByMe: true },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('ownedByMe=1');
  });

  it('ownedByMe=false (default) strips the key from the query string', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('ownedByMe=');
  });

  it('ownedByMe=true composes with every other chip + q + from + to + sort + selected in a single query string', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=high');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    // Negative shape: no `ownedBy=` legacy enum-key form ever leaks
    // through — the wire shape is the boolean-flag literal `'1'` only.
    expect(out).not.toContain('ownedBy=');
    // Negative shape: the legacy `snoozed=true` form does NOT survive
    // the rename — the wire shape is `hideSnoozed=1` only.
    expect(out).not.toContain('snoozed=');
  });

  it('legacy `?ownedBy=me` URL on inbound params does NOT round-trip into the writer (no silent alias)', () => {
    // The boolean-flag wire shape is `ownedByMe=1`. A stale bookmark
    // carrying the old enum-key form (`?ownedBy=me`) must NOT re-emit
    // — the writer reads its state exclusively from `input.ownedByMe`
    // and strips the legacy key. A future widening that silently
    // aliases the old key would re-add a stale flipping surface, so
    // this case pins the absence.
    const incoming = new URLSearchParams();
    incoming.set('ownedBy', 'me');
    const out = buildEffectiveQs(defaults(), incoming, new Set());
    expect(out).not.toContain('ownedBy=');
    expect(out).not.toContain('ownedByMe=');
  });
});

describe('buildEffectiveQs — hideSnoozed URL round-trip', () => {
  // hideSnoozed is an INVERTED toggle: the URL key is OFF (absent) by
  // default and the literal `'1'` is the only on-form. The literal-form
  // contract is what lets the brief's "round-trip via ?hideSnoozed=1"
  // acceptance criterion land exactly on the wire.
  it('hideSnoozed=false (default) strips the key from the query string', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('hideSnoozed=');
  });

  it('hideSnoozed=true emits the literal hideSnoozed=1 in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), hideSnoozed: true },
      new URLSearchParams(),
      new Set(),
    );
    const parsed = parseOut(out);
    expect(parsed.get('hideSnoozed')).toBe('1');
    expect(out).toContain('hideSnoozed=1');
  });

  it('permalink round-trip: ?hideSnoozed=1 → parsed state hideSnoozed=true → url still contains hideSnoozed=1', () => {
    // Mirror the page lazy-initializer for `hideSnoozed`. The zod
    // contract parses `?hideSnoozed=1` as `parsed.data.hideSnoozed
    // === '1'`; the page then folds that back to a boolean and the
    // writer emits the literal `'1'` so the URL is stable across a
    // navigate-back-and-forth.
    const incoming = new URLSearchParams();
    incoming.set('hideSnoozed', '1');
    const parsedHideSnoozed = incoming.get('hideSnoozed') === '1';
    const out = buildEffectiveQs(
      { ...defaults(), hideSnoozed: parsedHideSnoozed },
      incoming,
      new Set(),
    );
    expect(parseOut(out).get('hideSnoozed')).toBe('1');
  });

  it('permalink for ?hideSnoozed=true (legacy form) parses as absent, strips the key', () => {
    // The wire shape is the literal `'1'` only — even an incoming
    // ?hideSnoozed=true URL falls through to `false` because the page
    // lazy initializer reads the boolean from the zod parse (which
    // accepts only the literal `'1'`). The writer then omits the key
    // since the boolean is `false`. Negative-shape guard against a
    // future widened contract that silently accepts `'true'` again.
    const incoming = new URLSearchParams();
    incoming.set('hideSnoozed', 'true');
    const parsedHideSnoozed = incoming.get('hideSnoozed') === '1';
    const out = buildEffectiveQs(
      { ...defaults(), hideSnoozed: parsedHideSnoozed },
      incoming,
      new Set(),
    );
    expect(out).not.toContain('hideSnoozed=');
  });

  it('composes hideSnoozed=true with severity + status + ownedByMe + q + from + to + sort + since + selected', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=high');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
  });
});

describe('buildEffectiveQs — false_positive status URL round-trip', () => {
  it('status="false_positive" emits status=false_positive in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), status: 'false_positive' },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=false_positive');
  });

  it('composes status=false_positive with other filters without overlap', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['critical']),
        status: 'false_positive',
        ownedByMe: true,
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('status=false_positive');
    expect(out).toContain('severity=critical');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('q=log4j');
    expect(out).toContain('selected=');
  });
});

describe('buildEffectiveQs — snoozed enum status URL round-trip', () => {
  // Brief: the new `Snoozed` chip on `AlertsStatusChipRow` emits
  // `?status=snoozed` from the enum chip family rather than the
  // boolean-flag row's `?snoozed=1`. Both routes resolve the literal
  // to the same `snoozedUntil > now` predicate, so a permalink or
  // chip click surfaces the same effective query from either wire
  // key. The writer emits the enum literal verbatim on its own
  // (`?(status=snoozed)`); composing with `snoozedOnly` produces
  // BOTH keys (`?status=snoozed&snoozed=1`), which is acceptable
  // because both routes still apply the same WHERE clause (the URL
  // is over-specified but not contradictory).

  it('status="snoozed" emits status=snoozed in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), status: 'snoozed' },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=snoozed');
  });

  it('status="snoozed" round-trip: permalink ?status=snoozed → state snoozed → url still contains status=snoozed', () => {
    // The enum chip is fed by `parseFiltersFromParams(...).status` on
    // the page, which reads the widened `StatusFilterWire` zod parse
    // (now includes `'snoozed'` as a wire-only literal). A permalink
    // claim lands cleanly without overflow — the writer emits the
    // literal `status=snoozed` back so reload survives.
    const incoming = new URLSearchParams();
    incoming.set('status', 'snoozed');
    const parsedStatus = incoming.get('status');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        status:
          parsedStatus === 'in_progress' ||
          parsedStatus === 'resolved' ||
          parsedStatus === 'false_positive' ||
          parsedStatus === 'snoozed'
            ? (parsedStatus as 'in_progress' | 'snoozed' | 'resolved' | 'false_positive')
            : null,
      },
      incoming,
      new Set(),
    );
    expect(parseOut(out).get('status')).toBe('snoozed');
  });

  it('status="snoozed" composes with severity + ownedByMe + q + from + to + selected', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['critical']),
        status: 'snoozed',
        ownedByMe: true,
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('status=snoozed');
    expect(out).toContain('severity=critical');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
  });

  it('status="snoozed" composes with snoozedOnly (both wire keys present, no duplication of status=)', () => {
    // Regression guard: the enum chip and the boolean-flag chip
    // both target `snoozedUntil > now`. Activating one and the
    // other produces BOTH `?status=snoozed` AND `?snoozed=1` —
    // both routes apply the same WHERE so the over-saturated URL
    // is non-contradictory. The writer must NOT duplicate the
    // enum key (`?status=snoozed&status=snoozed&snoozed=1`), so
    // `params.set('status', ...)` (single-write) is what the
    // writer does today — this test pins that contract.
    const out = buildEffectiveQs(
      {
        ...defaults(),
        status: 'snoozed',
        snoozedOnly: true,
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=snoozed');
    expect(out).toContain('snoozed=1');
    // The writer must NOT emit two `status=` keys — `URLSearchParams.set`
    // is single-write (replaces). Regression guard against a future
    // refactor that switches to `append` and silently duplicates.
    const statusMatches = out.match(/status=/g) ?? [];
    expect(statusMatches.length).toBe(1);
  });

  it('status="snoozed" with openOnly=true (boolean-flag lane wins, enum literal is suppressed)', () => {
    // The writer's `openOnly > status` precedence is preserved on
    // the new derived arm — when `openOnly` is true the boolean-flag
    // lane owns `?status=open`, and the enum chip row's `'snoozed'`
    // literal is suppressed (NOT re-emitted as a duplicate). Same
    // posture as the rest of the enum family — `openOnly` wins over
    // every enum status.
    const out = buildEffectiveQs(
      {
        ...defaults(),
        status: 'snoozed',
        openOnly: true,
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=open');
    expect(out).not.toContain('status=snoozed');
  });
});

describe('buildEffectiveQs — asset URL round-trip (multi-select composite)', () => {
  // Brief criterion: the URL writes `?asset=foo,bar` in canonical
  // alphabetical CSV form, drops the key on a cleared chip strip, and
  // composes with every other chip + selection state without
  // overlapping (mirror of how `severity` rides alongside).

  it('null asset strips the asset key from the query string', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('asset=');
  });

  it('empty Set strips the asset key from the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), asset: new Set() },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).not.toContain('asset=');
  });

  it('Set{example.com:443/tcp, vpn.example.com:80/udp} emits alphabetical canonical CSV', () => {
    const out = buildEffectiveQs(
      {
        ...defaults(),
        asset: new Set(['example.com:443/tcp', 'vpn.example.com:80/udp']),
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('asset')).toBe('example.com:443/tcp,vpn.example.com:80/udp');
  });

  it('Set in non-canonical order still emits canonical CSV', () => {
    const out = buildEffectiveQs(
      {
        ...defaults(),
        asset: new Set(['z.example.com:443/tcp', 'a.example.com:80/tcp']),
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('asset')).toBe('a.example.com:80/tcp,z.example.com:443/tcp');
  });

  it('single-element Set emits only one entry', () => {
    const out = buildEffectiveQs(
      { ...defaults(), asset: new Set(['only.example.com:443/tcp']) },
      new URLSearchParams(),
      new Set(),
    );
    expect(parseOut(out).get('asset')).toBe('only.example.com:443/tcp');
  });

  it('composes asset with severity + status + ownedByMe + q + from + to + sort + selected', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        sort: 'severity',
        since: '7d',
        asset: new Set(['example.com:443/tcp', 'vpn.example.com:80/udp']),
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    // Every chip rides the URL alongside asset, including the textual
    // inputs the chip writer preserves from `incomingSearchParams`.
    expect(out).toContain('severity=high');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    // Asset emissions in alphabetical canonical CSV (a single value
    // here — the alphabetical emission is proven by the earlier tests).
    expect(parseOut(out).get('asset')).toBe('example.com:443/tcp,vpn.example.com:80/udp');
  });

  it('permalink ?asset=foo round-trips: state Set → url contains foo', () => {
    // Mirror the page lazy initializer — `parseAssetFilter` from
    // `@/lib/business/alerts-asset` parses the canonical CSV into a
    // canonical list, the writer emits it back as the same canonical
    // CSV. The round-trip is byte-for-byte stable.
    const incoming = new URLSearchParams();
    incoming.set('asset', 'example.com:443/tcp');
    const parsed = new Set(parseHelper(incoming.get('asset') ?? ''));
    const out = buildEffectiveQs({ ...defaults(), asset: parsed }, incoming, new Set());
    expect(parseOut(out).get('asset')).toBe('example.com:443/tcp');
  });

  it('permalink ?asset=z,b,a (non-canonical order) round-trips into canonical', () => {
    const incoming = new URLSearchParams();
    incoming.set('asset', 'z:b/a,b:b/a,a:b/a');
    // Page lazy init: split, trim, dedupe, sort alphabetically via
    // `localeCompare` — the canonical list then emerges.
    const parsed = new Set(parseHelper(incoming.get('asset') ?? ''));
    const out = buildEffectiveQs({ ...defaults(), asset: parsed }, incoming, new Set());
    expect(parseOut(out).get('asset')).toBe('a:b/a,b:b/a,z:b/a');
  });
});

describe('buildEffectiveQs — remediatedOnly URL round-trip', () => {
  it('remediatedOnly=true emits remediated=1 in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), remediatedOnly: true },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('remediated=1');
  });

  it('remediatedOnly=false (default) strips the key from the query string', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('remediated=');
  });

  it('permalink round-trip: ?remediated=1 → parsed state remediatedOnly=true → url still contains remediated=1', () => {
    const incoming = new URLSearchParams();
    incoming.set('remediated', '1');
    const parsedRemediatedOnly = incoming.get('remediated') === '1';
    const out = buildEffectiveQs(
      { ...defaults(), remediatedOnly: parsedRemediatedOnly },
      incoming,
      new Set(),
    );
    const parsed = parseOut(out);
    expect(parsed.get('remediated')).toBe('1');
  });

  it('remediatedOnly=true composes with every other chip + q + from + to + sort + since + selected', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=high');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('remediated=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    // Negative shape: the wire key is `remediated`, NOT `remediatedOnly`
    expect(out).not.toContain('remediatedOnly=');
  });

  it('permalink for ?remediated=true (non-literal) parses as absent, strips the key', () => {
    const incoming = new URLSearchParams();
    incoming.set('remediated', 'true');
    const parsedRemediatedOnly = incoming.get('remediated') === '1';
    const out = buildEffectiveQs(
      { ...defaults(), remediatedOnly: parsedRemediatedOnly },
      incoming,
      new Set(),
    );
    expect(out).not.toContain('remediated=');
  });
});

describe('buildEffectiveQs — snoozedOnly URL round-trip', () => {
  it('snoozedOnly=true emits snoozed=1 in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), snoozedOnly: true },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('snoozed=1');
  });

  it('snoozedOnly=false (default) strips the key from the query string', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('snoozed=');
  });

  it('permalink round-trip: ?snoozed=1 → parsed state snoozedOnly=true → url still contains snoozed=1', () => {
    const incoming = new URLSearchParams();
    incoming.set('snoozed', '1');
    const parsedSnoozedOnly = incoming.get('snoozed') === '1';
    const out = buildEffectiveQs(
      { ...defaults(), snoozedOnly: parsedSnoozedOnly },
      incoming,
      new Set(),
    );
    const parsed = parseOut(out);
    expect(parsed.get('snoozed')).toBe('1');
  });

  it('snoozedOnly=true composes with every other chip + q + from + to + sort + since + selected', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: true,
        snoozedOnly: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=high');
    expect(out).toContain('status=in_progress');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('remediated=1');
    expect(out).toContain('snoozed=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    // Negative shape: no `snoozedOnly=` leak beyond the boolean-flag wire key.
    expect(out).not.toContain('snoozedOnly=');
  });

  it('permalink for ?snoozed=true (non-literal) parses as absent, strips the key', () => {
    const incoming = new URLSearchParams();
    incoming.set('snoozed', 'true');
    const parsedSnoozedOnly = incoming.get('snoozed') === '1';
    const out = buildEffectiveQs(
      { ...defaults(), snoozedOnly: parsedSnoozedOnly },
      incoming,
      new Set(),
    );
    expect(out).not.toContain('snoozed=');
  });
});

describe('buildEffectiveQs — openOnly URL round-trip', () => {
  // The new boolean-flag chip row (alerts-open-chip-row). Wire key
  // is the LITERAL string `'open'` (`?status=open`), NOT the rest
  // of the family's `'1'` literal — see the collision note on
  // `@/components/dashboard/alerts-open-chip-row`. The writer
  // emits `?status=open` (NOT a fresh `openOnly=` key) so a
  // permalink with `?status=open` round-trips verbatim through
  // the page's `parseFiltersFromParams` claim. The enum chip
  // row's `'open'` chip was REMOVED so two chip rows can't fire
  // the same URL key.
  it('openOnly=true emits status=open in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), openOnly: true },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=open');
  });

  it('openOnly=false (default) strips the status key from the query string', () => {
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('status=');
  });

  it('permalink round-trip: ?status=open → parsed state openOnly=true → url still contains status=open', () => {
    // Mirror the page lazy-initializer: the page's
    // `parseFiltersFromParams` claims `?status=open` BEFORE the
    // AlertQuery zod parse, so on a permalink with the literal
    // the parsed state lands at `openOnly: true` + `status: null`.
    // The page's `useState` setter writes `openOnly: true` to the
    // `EffectiveQsInput`, and the writer emits `status=open`.
    const incoming = new URLSearchParams();
    incoming.set('status', 'open');
    // Page-lazy-init pattern: only the literal 'open' is claimed by
    // the boolean-flag lane; everything else falls through.
    const parsedOpenOnly = incoming.get('status') === 'open';
    const out = buildEffectiveQs({ ...defaults(), openOnly: parsedOpenOnly }, incoming, new Set());
    const parsed = parseOut(out);
    expect(parsed.get('status')).toBe('open');
  });

  it('openOnly=true composes with every other chip + q + from + to + sort + since + selected AND the enum status does NOT leak through', () => {
    // Brief: `openOnly > status` precedence means the boolean-flag
    // writer wins. When the writer sees `openOnly: true` it skips
    // the enum writer line, so even with `status: 'in_progress'`
    // set the URL still emits `status=open` exclusively (the
    // enum chip's writer line is gated by the precedence).
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        status: 'in_progress',
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: true,
        snoozedOnly: true,
        openOnly: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=high');
    expect(out).toContain('status=open');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('remediated=1');
    expect(out).toContain('snoozed=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    // Negative shape: the writer NEVER emits `openOnly=` — the
    // wire key is `status=`, owned by both the enum chip and the
    // boolean-flag chip in mutually-exclusive precedence.
    expect(out).not.toContain('openOnly=');
  });

  it('permalink ?status=in_progress (enum chip, no flag) round-trips verbatim — writer emits the literal', () => {
    // The enum chip and the new boolean-flag chip share the
    // `status=` wire key, but the writer's precedence means only
    // ONE of them writes per emission. With `openOnly: false`
    // (the resting state) the enum chip's writer line runs unchanged
    // so the enum literals (`in_progress | resolved |
    // false_positive`) round-trip verbatim.
    const incoming = new URLSearchParams();
    incoming.set('status', 'in_progress');
    const parsedOpenOnly = incoming.get('status') === 'open';
    const out = buildEffectiveQs(
      {
        ...defaults(),
        openOnly: parsedOpenOnly,
        status: 'in_progress',
      },
      incoming,
      new Set(),
    );
    expect(parseOut(out).get('status')).toBe('in_progress');
  });

  it('permalink for ?status=foo (non-literal, non-open) parses as absent, strips the status key', () => {
    // Hard-reject path mirror: the page's `parseFiltersFromParams`
    // returns `openOnly: false` + `status: null` on a non-literal
    // (the AlertQuery zod parse rejects `status=foo` with .success
    // false, falls through to the default branch which has `status:
    // null` + `openOnly: false`). The writer then omits `status=`
    // entirely since BOTH paths are off.
    const incoming = new URLSearchParams();
    incoming.set('status', 'foo');
    const parsedOpenOnly = incoming.get('status') === 'open';
    const out = buildEffectiveQs({ ...defaults(), openOnly: parsedOpenOnly }, incoming, new Set());
    expect(out).not.toContain('status=');
  });
});

describe('buildEffectiveQs — resolvedOnly URL round-trip', () => {
  // The new boolean-flag chip row (alerts-resolved-chip-row). Wire
  // key is the LITERAL string `'resolved'` (`?status=resolved`),
  // written through the SAME url key the enum's 'Resolved' chip
  // already used — see why this overlaps on the wire-key collision
  // note on `@/components/dashboard/alerts-resolved-chip-row`.
  // Page-level mutex keeps `openOnly` and `resolvedOnly` mutually
  // exclusive across the boolean-flag family — when `openOnly: true`
  // the writer's precedence keeps `openOnly > resolvedOnly >
  // status`, so the literal `'open'` wins. When `resolvedOnly: true`
  // and `openOnly: false` the writer emits `?status=resolved` and
  // SKIPS the enum chip's writer line; when both boolean flags are
  // off, the enum chip's writer line runs unchanged so its other
  // literals (`in_progress | snoozed | false_positive`) round-trip
  // verbatim.
  it('resolvedOnly=true emits status=resolved in the query string', () => {
    const out = buildEffectiveQs(
      { ...defaults(), resolvedOnly: true },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=resolved');
  });

  it('resolvedOnly=false (default) strips the status key when no enum status is set', () => {
    // The brief's default behavior flip — when no `?status=` is on
    // the URL the page lands at `resolvedOnly: false` + `status:
    // null`, and the writer MUST omit `status=` so the route's
    // default-exclude-resolved arm applies instead of surfacing
    // every row. Mirrors the openOnly resting-state contract.
    const out = buildEffectiveQs(defaults(), new URLSearchParams(), new Set());
    expect(out).not.toContain('status=');
  });

  it('resolvedOnly=true + status="false_positive" — boolean-flag lane wins, enum literal is suppressed', () => {
    // Brief: `resolvedOnly > status` precedence means the
    // boolean-flag writer wins. When `resolvedOnly: true` the
    // enum chip row's `'false_positive'` literal is suppressed
    // (NOT re-emitted as a duplicate). The mutex on the page
    // hard-prevents both arms being set, but the writer reads
    // the merged input so the precedence has to be enforced here.
    const out = buildEffectiveQs(
      {
        ...defaults(),
        status: 'false_positive',
        resolvedOnly: true,
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=resolved');
    expect(out).not.toContain('status=false_positive');
    // Negative shape: the writer NEVER emits a fresh `resolvedOnly=`
    // key — the wire key is `status=`, owned by both the enum chip
    // and the boolean-flag chip in mutually-exclusive precedence.
    expect(out).not.toContain('resolvedOnly=');
  });

  it('permalink round-trip: ?status=resolved → parsed state resolvedOnly=true → url still contains status=resolved', () => {
    // Mirror the page lazy-initializer: on a permalink claim
    // `?status=resolved` lands at `resolvedOnly: true` + `status:
    // null` (the boolean-flag lane claims the literal BEFORE the
    // zod parse hands it back to the enum). The writer then
    // emits the literal back so a reload/CSV-anchor survives
    // the chip click → URL write → re-render cycle.
    const incoming = new URLSearchParams();
    incoming.set('status', 'resolved');
    // Mirror page lazy-init: claim `?status=resolved` as
    // `resolvedOnly: true` + `status: null`.
    const parsedResolvedOnly = incoming.get('status') === 'resolved';
    const out = buildEffectiveQs(
      { ...defaults(), resolvedOnly: parsedResolvedOnly },
      incoming,
      new Set(),
    );
    const parsed = parseOut(out);
    expect(parsed.get('status')).toBe('resolved');
  });

  it('openOnly=true + resolvedOnly=true → openOnly wins (precedence preserves the literal open)', () => {
    // The mutex on the page hard-prevents both arms being set,
    // but the writer reads the merged input so the precedence
    // has to be enforced here: when BOTH boolean-flag lanes are
    // true the writer emits `?status=open` (NOT `?status=resolved`).
    const out = buildEffectiveQs(
      {
        ...defaults(),
        openOnly: true,
        resolvedOnly: true,
      },
      new URLSearchParams(),
      new Set(),
    );
    expect(out).toContain('status=open');
    expect(out).not.toContain('status=resolved');
  });

  it('resolvedOnly=true composes with owner, severity, and other independent filters', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        triggeredBy: 'ci-webhook',
        hideSnoozed: true,
        ownedByMe: true,
        remediatedOnly: false,
        snoozedOnly: true,
        openOnly: false,
        resolvedOnly: true,
        sort: 'severity',
        since: '7d',
      },
      incoming,
      new Set(['alert-1', 'alert-2']),
    );
    expect(out).toContain('severity=high');
    expect(out).toContain('status=resolved');
    expect(out).toContain('ownedByMe=1');
    expect(out).toContain('triggeredBy=ci-webhook');
    expect(out).toContain('hideSnoozed=1');
    expect(out).toContain('snoozed=1');
    expect(out).toContain('sort=severity');
    expect(out).toContain('since=7d');
    expect(out).toContain('q=log4j');
    expect(out).toContain('from=2026-07-01');
    expect(out).toContain('to=2026-07-23');
    expect(out).toContain('selected=');
    // Negative shape: no `status=` duplication (URLSearchParams.set
    // is single-write), no `resolvedOnly=` leak.
    expect(out).not.toContain('resolvedOnly=');
    const statusMatches = out.match(/status=/g) ?? [];
    expect(statusMatches.length).toBe(1);
  });

  it('clearing Resolved removes only status while preserving the other URL filters', () => {
    const incoming = new URLSearchParams();
    incoming.set('q', 'log4j');
    incoming.set('from', '2026-07-01');
    incoming.set('to', '2026-07-23');
    const out = buildEffectiveQs(
      {
        ...defaults(),
        severity: new Set<SeverityLiteral>(['high']),
        triggeredBy: 'ci-webhook',
        ownedByMe: true,
        remediatedOnly: true,
        snoozedOnly: true,
        sort: 'severity',
        since: '7d',
        asset: new Set(['example.com:443/tcp']),
      },
      incoming,
      new Set(['alert-1']),
    );
    const parsed = parseOut(out);

    expect(parsed.has('status')).toBe(false);
    expect(parsed.get('severity')).toBe('high');
    expect(parsed.get('ownedByMe')).toBe('1');
    expect(parsed.get('triggeredBy')).toBe('ci-webhook');
    expect(parsed.get('remediated')).toBe('1');
    expect(parsed.get('snoozed')).toBe('1');
    expect(parsed.get('sort')).toBe('severity');
    expect(parsed.get('since')).toBe('7d');
    expect(parsed.get('asset')).toBe('example.com:443/tcp');
    expect(parsed.get('q')).toBe('log4j');
    expect(parsed.get('from')).toBe('2026-07-01');
    expect(parsed.get('to')).toBe('2026-07-23');
    expect(parsed.get('selected')).toBe('alert-1');
  });
});

describe('buildEffectiveQs — workflow status preserves the complete active filter set', () => {
  const filterQuery =
    'resolution=unresolved&severity=critical%2Chigh&source=manual&triggeredBy=scheduled&status=in_progress&acknowledged=false&assigneeReady=true&hideSnoozed=1&highRiskAssets=1&q=CVE-2026-90001&hostname=api.example.test&asset=api.example.test%3A443%2Ftcp&from=2026-10-01&to=2026-10-31&since=7d&sort=created_asc&ownedByMe=1&remediated=1&snoozed=1';

  function activeInput(status: EffectiveQsInput['status']): EffectiveQsInput {
    return {
      ...defaults(),
      resolution: 'unresolved',
      severity: new Set<SeverityLiteral>(['critical', 'high']),
      status,
      triggeredBy: 'scheduled',
      hideSnoozed: true,
      highRiskAssets: true,
      ownedByMe: true,
      remediatedOnly: true,
      snoozedOnly: true,
      sort: 'created:asc',
      since: '7d',
      asset: new Set(['api.example.test:443/tcp']),
    };
  }

  function asRecord(params: URLSearchParams): Record<string, string> {
    return Object.fromEntries(params.entries());
  }

  it.each([
    ['created', 'created'],
    ['created_asc', 'created:asc'],
  ] as const)(
    'switching to sort=%s preserves all active filters and restores the selected direction',
    (wireSort, sort) => {
      const incoming = new URLSearchParams(filterQuery);
      const out = buildEffectiveQs(
        { ...activeInput('in_progress'), sort },
        incoming,
        new Set(),
      );
      const restoredParams = parseOut(out);

      expect(asRecord(restoredParams)).toEqual({
        ...asRecord(incoming),
        sort: wireSort,
      });
      const restoredQuery = AlertQuery.safeParse(asRecord(restoredParams));
      expect(restoredQuery.success).toBe(true);
      if (restoredQuery.success) expect(restoredQuery.data.sort).toBe(sort);
    },
  );

  it.each(['open', 'in_progress', 'resolved', 'false_positive', 'snoozed'] as const)(
    'selecting status=%s retains all other supported URL filters and values',
    (status) => {
      const incoming = new URLSearchParams(filterQuery);
      const out = buildEffectiveQs(
        {
          ...activeInput(status === 'open' ? null : status),
          openOnly: status === 'open',
        },
        incoming,
        new Set(),
      );

      expect(asRecord(parseOut(out))).toEqual({
        ...asRecord(incoming),
        status,
      });
    },
  );

  it.each(['open', 'in_progress', 'resolved', 'false_positive', 'snoozed'] as const)(
    'restores status=%s from a matching URL and rebuilds the same status URL',
    (status) => {
      const restored = parseAlertWorkflowStatus(new URLSearchParams(`status=${status}`).get('status'));
      expect(restored).toBe(status);

      const out = buildEffectiveQs(
        {
          ...activeInput(status === 'open' ? null : status),
          openOnly: status === 'open',
        },
        new URLSearchParams(),
        new Set(),
      );
      expect(parseOut(out).get('status')).toBe(restored);
    },
  );

  it('restores an absent or unsupported status as All', () => {
    expect(parseAlertWorkflowStatus(new URLSearchParams().get('status'))).toBeNull();
    expect(parseAlertWorkflowStatus('unknown')).toBeNull();
  });

  it('clearing status removes only status and keeps every other supported filter value', () => {
    const incoming = new URLSearchParams(filterQuery);
    const out = buildEffectiveQs(
      {
        ...activeInput(null),
        openOnly: false,
        resolvedOnly: false,
      },
      incoming,
      new Set(),
    );
    const expected = asRecord(incoming);
    delete expected.status;
    expect(asRecord(parseOut(out))).toEqual(expected);
  });
});

// Minimal local copy of the page-level parser used by the round-trip
// tests. The semantics mirror `parseAssetFilter` from
// `@/lib/business/alerts-asset` strictly enough to satisfy the
// round-trip contract assertions above (alphabetical canonical,
// comma-split, whitespace-tolerant, dedupe). Kept inline here so the
// round-trip test doesn't have to import from a module whose
// canonical list overlap with the emitter's — the round-trip is
// proof the lazy-init-then-emit cycle ends up at the same wire
// shape regardless of which one runs.
function parseHelper(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of input.split(',')) {
    const t = piece.trim();
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
