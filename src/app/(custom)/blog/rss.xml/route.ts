// @polsia:user-owned — RSS 2.0 feed for /blog. The static `rss.xml` segment
// resolves before the `[slug]` dynamic segment in App Router precedence, so
// this URL does not collide with the blog-reader page.
//
// External feed readers (Feedly, NetNewsWire) and crawlers HTTP-GET this
// URL; the response carries `Content-Type: application/rss+xml` so they
// key on it without sniffing HTML. `force-static` + a conservative
// Cache-Control header let Next prerender at build time and serve from
// cache for an hour.
//
// `buildRssXml()` lives in src/lib/business/blog-rss.ts because route.ts
// files only accept HTTP-method exports — any extra named export fails
// type-check ("is not a valid Route export field").

import 'server-only';

import { buildRssXml } from '@/lib/business/blog-rss';

export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return new Response(buildRssXml(), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
}
