// @vitest-environment node
// Neutralize server-only so the route handler can be unit-tested directly.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// The helper transitively imports `@/lib/brand` → `@/lib/site` → `@/lib/env`,
// and `@/lib/env` runs t3 schema validation at module-init time, throwing
// on any unset server var. Bypass it for this test (it's an env check, not
// the unit under test).
const prevSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
process.env.SKIP_ENV_VALIDATION = '1';

const { RSS_TZ_GMT_RE, buildRssXml } = await import('@/lib/business/blog-rss');
const { GET } = await import('@/app/(custom)/blog/rss.xml/route');

// Restore the user-set value so this test file isn't the last one to touch env.
// Vitest runs files in their own workers and the process usually exits after,
// but doing it is harmless.
process.env.SKIP_ENV_VALIDATION = prevSkipEnvValidation ?? undefined;

const RFC_822_RE = RSS_TZ_GMT_RE;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe('/blog/rss.xml route — buildRssXml()', () => {
  it('emits a valid XML declaration and rss 2.0 envelope with atom namespace', () => {
    const xml = buildRssXml();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toMatch(
      /<atom:link href="[^"]+\/blog\/rss\.xml" rel="self" type="application\/rss\+xml" \/>/,
    );
  });

  it('has a channel block with site-derived identity', () => {
    const xml = buildRssXml();

    const channelTitle = xml.match(/<channel>[\s\S]*?<title>([^<]+)<\/title>/);
    expect(channelTitle).not.toBeNull();
    expect(channelTitle?.[1]).toMatch(/Blog$/);

    const channelLink = xml.match(/<channel>[\s\S]*?<link>([^<]+)<\/link>/);
    expect(channelLink).not.toBeNull();
    expect(channelLink?.[1]).toMatch(/\/blog$/);

    const channelDesc = xml.match(/<channel>[\s\S]*?<description>([^<]+)<\/description>/);
    expect(channelDesc?.[1]).toBeTruthy();
    expect(channelDesc?.[1].length).toBeGreaterThan(10);

    const lastBuild = xml.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/);
    expect(lastBuild?.[1]).toMatch(RFC_822_RE);
  });

  it('emits exactly three items from the seeded blog posts', () => {
    const xml = buildRssXml();
    expect(countOccurrences(xml, '<item>')).toBe(3);
    expect(countOccurrences(xml, '</item>')).toBe(3);
  });

  it('each item carries title, link, guid, description, pubDate, author, and category tags', () => {
    const xml = buildRssXml();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    expect(items).toHaveLength(3);

    for (const item of items) {
      const title = item.match(/<title>([^<]+)<\/title>/);
      expect(title?.[1]).toBeTruthy();

      const link = item.match(/<link>([^<]+)<\/link>/);
      expect(link?.[1]).toMatch(/^http/);

      const guid = item.match(/<guid isPermaLink="true">([^<]+)<\/guid>/);
      expect(guid?.[1]).toBeTruthy();
      expect(guid?.[1]).toContain('/blog/');

      const description = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
      expect(description?.[1]).toBeTruthy();
      expect(description?.[1].length).toBeGreaterThan(20);

      const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/);
      expect(pubDate?.[1]).toMatch(RFC_822_RE);

      const author = item.match(/<author>([^<]+)<\/author>/);
      expect(author?.[1]).toBeTruthy();
      expect(author?.[1]).toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);

      // Seeded posts have ≥1 tag; the route emits a <category> per tag.
      const categories = item.match(/<category>([^<]+)<\/category>/g) ?? [];
      expect(categories.length).toBeGreaterThan(0);
    }
  });

  it('pubDates match the seed timestamps in RFC-822 form', () => {
    const xml = buildRssXml();
    expect(xml).toContain(new Date('2026-07-08T09:00:00Z').toUTCString());
    expect(xml).toContain(new Date('2026-07-15T10:00:00Z').toUTCString());
    expect(xml).toContain(new Date('2026-07-22T11:00:00Z').toUTCString());
  });
});

describe('/blog/rss.xml route — GET()', () => {
  it('returns application/rss+xml with cache headers and the channel/items body', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toContain('public');
    const body = await res.text();
    expect(body).toContain('<rss version="2.0"');
    expect(body).toContain('<channel>');
    expect(countOccurrences(body, '<item>')).toBe(3);
  });
});
