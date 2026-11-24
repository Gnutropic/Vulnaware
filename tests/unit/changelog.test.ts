import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_ENTRIES } from '@/lib/content/changelog';
import { ChangelogEntry, ChangelogList } from '@/lib/contracts/changelog';

const EXPECTED_ENTRIES = [
  {
    id: 'resolved-alert-filter',
    title: 'Resolved-alert filter',
    body: 'Filter the alert list to resolved alerts.',
  },
  {
    id: 'asset-risk-score-trend',
    title: 'Asset risk-score trend',
    body: 'View an asset’s risk score over time.',
  },
  {
    id: 'dashboard-tiles',
    title: 'Dashboard tiles',
    body: 'Review product information in dashboard tiles.',
  },
  {
    id: 'pdf-export',
    title: 'PDF export',
    body: 'Export as a PDF.',
  },
  {
    id: 'snooze-summary-email-digest',
    title: 'Snooze-summary email digest',
    body: 'Receive an email digest summarizing snoozed alerts.',
  },
];

describe('public changelog content and contract', () => {
  it('contains the five supplied updates in their authored order', () => {
    expect(CHANGELOG_ENTRIES).toEqual(EXPECTED_ENTRIES);
  });

  it('uses unique stable IDs and the date-free shared response shape', () => {
    const ids = CHANGELOG_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ChangelogList.parse({ entries: CHANGELOG_ENTRIES })).toEqual({
      entries: EXPECTED_ENTRIES,
    });
    expect(CHANGELOG_ENTRIES.map((entry) => Object.keys(entry))).toEqual(
      EXPECTED_ENTRIES.map(() => ['id', 'title', 'body']),
    );
    expect(
      ChangelogEntry.safeParse({ ...EXPECTED_ENTRIES[0], date: '2026-09-29' }).success,
    ).toBe(false);
    expect(JSON.stringify(CHANGELOG_ENTRIES)).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  it('keeps the page free of date-based structured data and stale date-range copy', () => {
    const page = readFileSync(path.join(process.cwd(), 'src/app/(custom)/changelog/page.tsx'), 'utf8');
    expect(page).not.toContain('datePublished');
    expect(page).not.toMatch(/past six weeks|~6 weeks|hover a date|reverse-chronological/i);
    expect(page).toContain('`/changelog#entry-${entry.id}`');
  });
});
