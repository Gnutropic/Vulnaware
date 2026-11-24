// @polsia:user-owned — programmatic SEO URLs for /sitemap.xml: dynamic [slug]
// pages (e.g. /champions/[slug]) that aren't in the nav menu. Edit this file,
// never src/app/sitemap.ts (framework-owned). Return one entry per page with an
// app-absolute `path` ('/...'); may be async to fetch data. Return [] if none.
//
//   export async function seoRoutes(): Promise<SeoRoute[]> {
//     const items = await getItems();
//     return items.map((i) => ({ path: `/items/${i.slug}`, priority: 0.6 }));
//   }
import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/db';

/** App-absolute `path` (e.g. /items/aatrox) + optional Next sitemap fields. */
export type SeoRoute = { path: string } & Omit<MetadataRoute.Sitemap[number], 'url'>;

// `next build` runs BEFORE `prisma db push` (see polsia.toml), so the
// `Post` table may not yet exist when /sitemap.xml prerenders. We
// tolerate Prisma errors during the build phase: returning [] leaves
// /blog/<slug> off the first sitemap, but at runtime (post-`db push`)
// the same call returns real entries. Other code paths (real runtime
// reads in the index/reader pages) propagate errors as usual.
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function isMissingTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2021'
  );
}

const blogRssRoute: SeoRoute = {
  path: '/blog/rss.xml',
  priority: 0.5,
  changeFrequency: 'weekly',
};

export async function seoRoutes(): Promise<SeoRoute[]> {
  try {
    const posts = await prisma.post.findMany({
      where: { publishedAt: { not: null } },
      select: { slug: true, updatedAt: true },
    });
    const postsRoute = posts.map((p) => ({
      path: `/blog/${p.slug}`,
      priority: 0.6,
      lastModified: p.updatedAt,
    }));
    return [...postsRoute, blogRssRoute];
  } catch (err) {
    if (isBuildPhase() || isMissingTable(err)) return [blogRssRoute];
    throw err;
  }
}
