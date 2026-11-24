// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CHANGELOG_ENTRIES } from '@/lib/content/changelog';

vi.mock('server-only', () => ({}));

describe('GET /api/changelog', () => {
  it('returns the authored updates publicly without dates or a session', async () => {
    const { GET } = await import('@/app/api/changelog/route');
    const response = await GET();

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.entries).toEqual(CHANGELOG_ENTRIES);
    expect(payload.entries).toHaveLength(5);
    expect(payload.entries.map((entry: { title: string }) => entry.title)).toEqual(
      CHANGELOG_ENTRIES.map((entry) => entry.title),
    );
    expect(payload.entries.every((entry: Record<string, unknown>) => !('date' in entry))).toBe(true);
    expect(Object.keys(payload.entries[0])).toEqual(['id', 'title', 'body']);
  });
});
