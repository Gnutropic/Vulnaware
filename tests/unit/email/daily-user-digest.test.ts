// @vitest-environment node
// Unit tests for the per-user 08:30 UTC daily digest email template
// in src/lib/email/templates.ts, plus the pure Top-N pick helper
// from src/lib/business/daily-user-digest.ts.
//
// Coverage pinpoints (per the plan's brief + test rubric):
//   1. `dailyUserDigestEmail` renders per-severity labeled count
//      lines (`Critical: N`, `High: N`, `Medium: N`, `Low: N`) —
//      including the `: 0` form when a bucket is empty (mirrors
//      `dailyAlertDigestEmail`).
//   2. Subject carries the `[daily digest] … in the last 24h`
//      prefix; singular "1 item" when total is 1; NEVER contains
//      "1 items".
//   3. `topItems` render via `{kind:'link'}` with
//      `href="${base}/alerts/${item.id}"` — assert specifically for
//      both the critical and high rows. The text mirror contains
//      the same href.
//   4. A row that lives BELOW the top-N cap is NOT linked (the
//      caller passes at most 5 critical + 5 high totals so the
//      rendered envelope caps at 10).
//   5. Window bounds render as `YYYY-MM-DD HH:MM UTC`.
//   6. Inputs pass through unescaped so `renderEmail`'s own
//      `escapeHtml` runs — assert `&` and `<` in a `host` value
//      surface as `&amp;` and `&lt;`.
//   7. The pure `pickTopItems` helper exports the documented cap
//      (5 critical + 5 high); more rows of those severities are
//      silently dropped in (severity_rank, createdAt desc) order.

import { describe, expect, it, vi } from 'vitest';

// The business lib's top-level bar (`server-only`, `@/lib/db`,
// `@/lib/email/*`) needs to be stubbed so vitest can load the
// module. We only exercise the PURE helpers here — `pickTopItems`
// in the business lib + `dailyUserDigestEmail` in the email
// template — so stubbing the live transport is fine.
//
// templates.ts and the business lib BOTH import `@/lib/brand`,
// which transitively loads `@/lib/env`'s full zod schema. Stub
// `@/lib/brand` cleanly so the test can exercise the surface in
// isolation without the env-init chain.
vi.mock('@/lib/brand', () => ({
  brand: { name: 'Test' },
  siteName: 'Test',
  siteDescription: 'Test',
  brandVisual: { themeColor: '#000000', backgroundColor: '#000000', og: {} },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/email/from', () => ({ fromFor: () => '' }));
vi.mock('@/lib/email/send', () => ({ sendEmail: () => Promise.resolve({ id: '' }) }));

import { pickTopItems } from '@/lib/business/daily-user-digest';
import { dailyUserDigestEmail } from '@/lib/email/templates';

const BASE = 'http://localhost:3000';
const WIN_START = '2026-07-22T12:00:00.000Z';
const WIN_END = '2026-07-23T12:00:00.000Z';

describe('dailyUserDigestEmail', () => {
  it('subject carries the [daily digest] prefix and a "items" plural', () => {
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 6,
      severityCounts: { critical: 2, high: 3, medium: 1, low: 0 },
      topItems: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-2024-9999',
          host: '10.0.0.1',
          url: `${BASE}/alerts/alert-1`,
        },
      ],
      ctaUrl: `${BASE}/alerts`,
    });
    expect(out.subject).toMatch(/^\[daily digest\] /);
    expect(out.subject).toContain('6 items');
    expect(out.subject).toContain('in the last 24h');
  });

  it("uses 'item' (singular) in the subject when total is 1", () => {
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 1,
      severityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
      topItems: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-1',
          host: 'h',
          url: `${BASE}/alerts/alert-1`,
        },
      ],
      ctaUrl: `${BASE}/alerts`,
    });
    expect(out.subject).toContain('1 item');
    expect(out.subject).not.toContain('1 items');
  });

  it('renders per-severity labeled count lines including : 0 for empty buckets', () => {
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 6,
      severityCounts: { critical: 2, high: 3, medium: 1, low: 0 },
      topItems: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-1',
          host: 'h',
          url: `${BASE}/alerts/alert-1`,
        },
      ],
      ctaUrl: `${BASE}/alerts`,
    });
    expect(out.html).toContain('Critical: 2');
    expect(out.html).toContain('High: 3');
    expect(out.html).toContain('Medium: 1');
    // Empty bucket still renders the count line — mirror
    // dailyAlertDigestEmail's posture so the recipient learns
    // the bucket exists by name.
    expect(out.html).toContain('Low: 0');
    expect(out.text).toContain('Critical: 2');
    expect(out.text).toContain('High: 3');
    expect(out.text).toContain('Medium: 1');
    expect(out.text).toContain('Low: 0');
  });

  it('wires /alerts/[id] through {kind:"link"} for critical and high rows', () => {
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 2,
      severityCounts: { critical: 1, high: 1, medium: 0, low: 0 },
      topItems: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-2024-9999',
          host: '10.0.0.1',
          url: `${BASE}/alerts/alert-1`,
        },
        {
          id: 'alert-2',
          severity: 'high',
          cveId: 'CVE-2025-0007',
          host: '10.0.0.2',
          url: `${BASE}/alerts/alert-2`,
        },
      ],
      ctaUrl: `${BASE}/alerts`,
    });
    expect(out.html).toContain(`href="${BASE}/alerts/alert-1"`);
    expect(out.html).toContain(`href="${BASE}/alerts/alert-2"`);
    // Text mirror contains the same hrefs so a plaintext client
    // lands on the same per-row detail page.
    expect(out.text).toContain(`${BASE}/alerts/alert-1`);
    expect(out.text).toContain(`${BASE}/alerts/alert-2`);
    expect(out.html).toContain('CVE-2024-9999');
    expect(out.html).toContain('CVE-2025-0007');
  });

  it('does NOT link rows that live BELOW the top-N cap', () => {
    // Caller passes only the top 10 (5 critical + 5 high). A
    // "row 11" that lives beyond the cap never appears.
    const topItems = [];
    for (let i = 0; i < 5; i += 1) {
      topItems.push({
        id: `crit-${i}`,
        severity: 'critical',
        cveId: `CVE-CRIT-${i}`,
        host: `host-crit-${i}`,
        url: `${BASE}/alerts/crit-${i}`,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      topItems.push({
        id: `high-${i}`,
        severity: 'high',
        cveId: `CVE-HIGH-${i}`,
        host: `host-high-${i}`,
        url: `${BASE}/alerts/high-${i}`,
      });
    }
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 11,
      severityCounts: { critical: 6, high: 5, medium: 0, low: 0 },
      topItems,
      ctaUrl: `${BASE}/alerts`,
    });
    // First 10 row hrefs land ...
    expect(out.html).toContain(`href="${BASE}/alerts/crit-0"`);
    expect(out.html).toContain(`href="${BASE}/alerts/high-4"`);
    // ... and the 11th critical never appears.
    expect(out.html).not.toContain(`href="${BASE}/alerts/crit-5"`);
    expect(out.html).not.toContain(`CVE-CRIT-5`);
    expect(out.text).not.toContain(`CVE-CRIT-5`);
  });

  it('renders the window bounds as YYYY-MM-DD HH:MM UTC', () => {
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 1,
      severityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
      topItems: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-1',
          host: 'h',
          url: `${BASE}/alerts/alert-1`,
        },
      ],
      ctaUrl: `${BASE}/alerts`,
    });
    expect(out.html).toContain('2026-07-22 12:00 UTC');
    expect(out.html).toContain('2026-07-23 12:00 UTC');
    expect(out.text).toContain('2026-07-22 12:00 UTC');
    expect(out.text).toContain('2026-07-23 12:00 UTC');
  });

  it('HTML-escapes raw inputs (host with & and < round-trips as &amp; / &lt;)', () => {
    const out = dailyUserDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      totalItems: 1,
      severityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
      topItems: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-1',
          host: 'a&b<c.example',
          url: `${BASE}/alerts/alert-1`,
        },
      ],
      ctaUrl: `${BASE}/alerts`,
    });
    // escapeHtml runs via renderEmail — the rendered HTML carries
    // the entities, the raw `&` and `<` chars are gone.
    expect(out.html).toContain('a&amp;b&lt;c.example');
    expect(out.html).not.toContain('a&b<c.example');
    // Text mirror keeps the raw chars (no HTML escaping on the
    // plaintext path).
    expect(out.text).toContain('a&b<c.example');
  });
});

describe('pickTopItems', () => {
  // Helper to construct a row for the cap test. Mirrors the
  // RawAlertRow shape the selector now selects — `finding.asset`
  // carries `port + protocol` so the per-user asset filter can
  // resolve correctly.
  function mkRow(id: string, severity: string, createdMs: number) {
    return {
      id,
      teamId: 'team-1',
      ownerId: 'user-1',
      severity,
      createdAt: new Date(createdMs),
      finding: {
        cveId: `CVE-${id}`,
        asset: { host: `host-${id}`, port: 443, protocol: 'tcp' },
      },
    };
  }

  it('caps the critical bucket at 5 and the high bucket at 5', () => {
    const rows = [];
    for (let i = 0; i < 8; i += 1) {
      rows.push(mkRow(`crit-${i}`, 'critical', 1_700_000_000_000 + i));
    }
    for (let i = 0; i < 8; i += 1) {
      rows.push(mkRow(`high-${i}`, 'high', 1_700_000_000_000 + 100 + i));
    }
    for (let i = 0; i < 8; i += 1) {
      rows.push(mkRow(`med-${i}`, 'medium', 1_700_000_000_000 + 200 + i));
    }
    for (let i = 0; i < 8; i += 1) {
      rows.push(mkRow(`low-${i}`, 'low', 1_700_000_000_000 + 300 + i));
    }
    const top = pickTopItems(rows);
    const counts = top.reduce(
      (acc, item) => {
        acc[item.severity] = (acc[item.severity] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    expect(counts.critical).toBe(5);
    expect(counts.high).toBe(5);
    expect(counts.medium ?? 0).toBe(0);
    expect(counts.low ?? 0).toBe(0);
  });

  it('drains critical before high; within a bucket, fresher rows come first', () => {
    // 2 criticals, 2 highs; the older critical outranks the
    // newer high because severity drain comes first.
    const critOlder = mkRow('crit-older', 'critical', 100);
    const critNewer = mkRow('crit-newer', 'critical', 200);
    const highOlder = mkRow('high-older', 'high', 150);
    const highNewer = mkRow('high-newer', 'high', 250);
    const top = pickTopItems([highNewer, highOlder, critOlder, critNewer]);
    expect(top.map((t) => t.id)).toEqual(['crit-newer', 'crit-older', 'high-newer', 'high-older']);
  });
});
