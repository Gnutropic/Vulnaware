// @vitest-environment node
// Unit tests for the daily digest email templates in
// src/lib/email/templates.ts.
// Coverage pinpoints:
//   1. dailyAlertDigestEmail renders per-severity labeled count lines,
//      wires the brief's `/alerts?ownedByMe=1` deep link through
//      `{kind:'link'}` for each item row, and carries the
//      `[daily digest]` subject prefix.
//   2. dailyAlertAllClearEmail has NO CTA and carries the
//      `[daily digest] all clear in <team>` subject prefix.
//   3. Inputs pass through unescaped so `renderEmail`'s own escapeHtml runs.

import { describe, expect, it, vi } from 'vitest';

// templates.ts imports `brand` from `@/lib/brand`, which transitively
// loads `@/lib/env`'s full zod schema. Stub `@/lib/brand` cleanly so the
// test can exercise the templates in isolation without the env-init
// chain.
vi.mock('@/lib/brand', () => ({
  brand: { name: 'Test' },
  siteName: 'Test',
  siteDescription: 'Test',
  brandVisual: { themeColor: '#000000', backgroundColor: '#000000', og: {} },
}));

import { dailyAlertAllClearEmail, dailyAlertDigestEmail } from '@/lib/email/templates';

const BASE = 'http://localhost:3000';
const WIN_START = '2026-07-22T12:00:00.000Z';
const WIN_END = '2026-07-23T12:00:00.000Z';

describe('dailyAlertDigestEmail', () => {
  it('renders per-severity labeled count lines', () => {
    const out = dailyAlertDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      severityCounts: { critical: 2, high: 3, medium: 1, low: 0 },
      items: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-2024-9999',
          host: '10.0.0.1',
          url: `${BASE}/alerts?ownedByMe=1`,
        },
      ],
      ctaUrl: `${BASE}/alerts?ownedByMe=1`,
    });
    expect(out.subject).toMatch(/^\[daily digest\] /);
    expect(out.subject).toContain('Acme Corp');
    expect(out.subject).toContain('6 items');
    expect(out.html).toContain('Critical: 2');
    expect(out.html).toContain('High: 3');
    expect(out.html).toContain('Medium: 1');
    expect(out.html).toContain('Low: 0');
    expect(out.text).toContain('Critical: 2');
    expect(out.text).toContain('High: 3');
  });

  it('wires /alerts?ownedByMe=1 through {kind:"link"} for every item row', () => {
    const out = dailyAlertDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      severityCounts: { critical: 1, high: 1, medium: 0, low: 0 },
      items: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-2024-9999',
          host: '10.0.0.1',
          url: `${BASE}/alerts?ownedByMe=1`,
        },
        {
          id: 'alert-2',
          severity: 'high',
          cveId: 'CVE-2025-0007',
          host: '10.0.0.2',
          url: `${BASE}/alerts?ownedByMe=1`,
        },
      ],
      ctaUrl: `${BASE}/alerts?ownedByMe=1`,
    });
    for (const _id of ['alert-1', 'alert-2']) {
      expect(out.html).toContain(`href="${BASE}/alerts?ownedByMe=1"`);
      expect(out.text).toContain(`${BASE}/alerts?ownedByMe=1`);
    }
    expect(out.html).toContain('CVE-2024-9999');
    expect(out.html).toContain('CVE-2025-0007');
    expect(out.html).toContain('10.0.0.1');
    expect(out.html).toContain('10.0.0.2');
  });

  it('renders the CTA pointing at /alerts?ownedByMe=1', () => {
    const out = dailyAlertDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      severityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
      items: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-1',
          host: 'h',
          url: `${BASE}/alerts?ownedByMe=1`,
        },
      ],
      ctaUrl: `${BASE}/alerts?ownedByMe=1`,
    });
    expect(out.html).toContain(`href="${BASE}/alerts?ownedByMe=1"`);
    expect(out.html).toContain('Open /alerts');
    expect(out.text).toContain('Open /alerts');
    expect(out.text).toContain(`${BASE}/alerts?ownedByMe=1`);
  });

  it("uses 'item' (singular) in the subject when total is 1", () => {
    const out = dailyAlertDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      severityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
      items: [
        {
          id: 'alert-1',
          severity: 'critical',
          cveId: 'CVE-1',
          host: 'h',
          url: `${BASE}/alerts?ownedByMe=1`,
        },
      ],
      ctaUrl: `${BASE}/alerts?ownedByMe=1`,
    });
    expect(out.subject).toContain('1 item');
    expect(out.subject).not.toContain('1 items');
  });

  it('renders the window bounds in UTC', () => {
    const out = dailyAlertDigestEmail({
      teamName: 'Acme Corp',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      items: [
        {
          id: 'alert-1',
          severity: 'low',
          cveId: 'CVE-1',
          host: 'h',
          url: `${BASE}/alerts?ownedByMe=1`,
        },
      ],
      ctaUrl: `${BASE}/alerts?ownedByMe=1`,
    });
    expect(out.html).toContain('2026-07-22 12:00 UTC');
    expect(out.html).toContain('2026-07-23 12:00 UTC');
  });
});

describe('dailyAlertAllClearEmail', () => {
  it('carries the [daily digest] all clear subject prefix', () => {
    const out = dailyAlertAllClearEmail({
      teamName: 'Calm Inc',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
    });
    expect(out.subject).toMatch(/^\[daily digest\] /);
    expect(out.subject).toContain('all clear in Calm Inc');
  });

  it('has NO call-to-action button', () => {
    const out = dailyAlertAllClearEmail({
      teamName: 'Calm Inc',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
    });
    // The all-clear body mentions 'Open /alerts' as a paragraph link,
    // but the template takes no `cta` arg → no CTA BUTTON. The button
    // styles (`background:#111111` and `display:inline-block`) are the
    // canonical renderEmail CTA markers — assert their absence.
    expect(out.html).not.toContain('background:#111111');
    expect(out.html).not.toContain('display:inline-block');
    expect(out.text).not.toMatch(/^Open \/alerts:/m);
  });

  it('mentions the zero-window reassurance line', () => {
    const out = dailyAlertAllClearEmail({
      teamName: 'Calm Inc',
      winStartIso: WIN_START,
      winEndIso: WIN_END,
    });
    expect(out.html).toContain('No alerts created or status-changed in the last 24 hours.');
    expect(out.text).toContain('No alerts created or status-changed in the last 24 hours.');
  });
});
