// @polsia:user-owned — pure RSS 2.0 builder for the /blog feed. Lives in a
// sibling helper (not inside the route handler) because Next.js restricts
// route.ts files to a small set of HTTP-method exports — any extra named
// export fails type-check. The route handler imports `buildRssXml` +
// `RSS_TZ_GMT_RE` from here, and the unit test exercises it directly
// without spinning up a Next request handler.
//
// Read source: the in-memory `BLOG_POSTS` literal in @/lib/business/blog-seed
// (no Prisma round-trip). The seed is the canonical source for the RSS feed
// and for the related-posts strip on the /blog/[slug] reader page, so the
// feed stays build-safe by construction.

import { brand } from '@/lib/brand';
import { BLOG_POSTS } from '@/lib/business/blog-seed';
import { siteName, siteUrl } from '@/lib/site';

const FEED_PATH = '/blog/rss.xml';
export const RSS_TZ_GMT_RE = /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildRssXml(): string {
  const channelTitle = `${siteName} Blog`;
  const channelLink = `${siteUrl}/blog`;
  const channelDescription = `Threat-intel posts from the ${brand.name} pipeline — how KEV, EPSS, and VulnCheck rank CVEs against your environment, ranked for action not novelty.`;
  const feedUrl = `${siteUrl}${FEED_PATH}`;

  const items = BLOG_POSTS.map((post) => {
    const postUrl = `${siteUrl}/blog/${post.slug}`;
    return [
      '    <item>',
      `      <title>${escapeXml(post.title)}</title>`,
      `      <link>${postUrl}</link>`,
      `      <guid isPermaLink="true">${postUrl}</guid>`,
      `      <description><![CDATA[${post.summary}]]></description>`,
      `      <pubDate>${post.publishedAt.toUTCString()}</pubDate>`,
      `      <author>${escapeXml(`${siteName} (${brand.contactEmail})`)}</author>`,
      ...post.tags.map((tag) => `      <category>${escapeXml(tag)}</category>`),
      '    </item>',
    ].join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(channelLink)}</link>`,
    `    <description>${escapeXml(channelDescription)}</description>`,
    `    <language>en-us</language>`,
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
