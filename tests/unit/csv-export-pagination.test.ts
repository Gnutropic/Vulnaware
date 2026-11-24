// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  CSV_SUPPORT_READ_BATCH_SIZE,
  forEachIdPage,
} from '@/lib/business/csv-export-pagination';

const rows = Array.from({ length: 10_001 }, (_, index) => ({
  id: `row-${String(index).padStart(5, '0')}`,
}));

describe('CSV supporting-read pagination', () => {
  it('consumes every ID beyond the CSV output limit in stable keyset pages', async () => {
    const cursors: Array<string | undefined> = [];
    const consumed: string[] = [];

    await forEachIdPage({
      signal: new AbortController().signal,
      fetchPage: async (afterId) => {
        cursors.push(afterId);
        return rows
          .filter((row) => afterId === undefined || row.id > afterId)
          .slice(0, CSV_SUPPORT_READ_BATCH_SIZE);
      },
      consume: async (page) => {
        consumed.push(...page.map((row) => row.id));
      },
    });

    expect(cursors).toHaveLength(3);
    expect(cursors[0]).toBeUndefined();
    expect(cursors.at(-1)).toBe('row-09999');
    expect(consumed).toEqual(rows.map((row) => row.id));
  });

  it('stops between pages when the export is cancelled', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => rows.slice(0, CSV_SUPPORT_READ_BATCH_SIZE));
    let consumed = 0;

    await expect(
      forEachIdPage({
        signal: controller.signal,
        fetchPage,
        consume: async (page) => {
          consumed += page.length;
          controller.abort();
        },
      }),
    ).rejects.toThrow('CSV export cancelled');

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(consumed).toBe(CSV_SUPPORT_READ_BATCH_SIZE);
  });
});
