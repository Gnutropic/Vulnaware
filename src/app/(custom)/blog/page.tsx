// @polsia:user-owned — public /blog index. Server Component so it can export
// per-page metadata (POL-2616). Pure RSC, no client island, so it reads
// Prisma directly via the @/lib/business/blog helper — no /api handler is
// needed (per nextjs-data-plane/SKILL.md, /api is reserved for client
// islands and form submissions). Belt-and-suspenders seed: if the DB has
// no published rows, insert the sample once (idempotent) so an anonymous
// visit lands on a populated list, not an empty state.

import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { brand } from '@/lib/brand';
import { getPublishedPosts } from '@/lib/business/blog';
import { seedBlogSample } from '@/lib/business/blog-seed';
import { siteName, siteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Blog',
  description: `Threat-intel posts from the ${brand.name} pipeline — how KEV, EPSS, and VulnCheck rank CVEs against your environment, ranked for action not novelty.`,
  alternates: {
    canonical: '/blog',
    types: { 'application/rss+xml': '/blog/rss.xml' },
  },
  openGraph: {
    type: 'website',
    url: '/blog',
    title: `Blog · ${siteName}`,
    description: `Threat-intel posts from the ${brand.name} pipeline — KEV, EPSS, and VulnCheck rankings explained in plain English.`,
  },
};

export default async function BlogIndexPage() {
  // Belt-and-suspenders: cover the never-signed-in case. The seed is
  // idempotent on slug, so even thousands of guard calls cost one DB
  // query after the first insert.
  let posts = await getPublishedPosts({ limit: 20 });
  if (posts.length === 0) {
    await seedBlogSample();
    posts = await getPublishedPosts({ limit: 20 });
  }

  const blogJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${siteName} Blog`,
    url: `${siteUrl}/blog`,
    description: metadata.description ?? undefined,
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${siteUrl}/blog/${p.slug}`,
      datePublished: p.publishedAt.toISOString(),
      keywords: p.tags.join(', '),
    })),
  };
  const itemListJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: posts.map((p, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      url: `${siteUrl}/blog/${p.slug}`,
      name: p.title,
    })),
  };

  return (
    <main className="relative">
      {/* ===================== HERO ===================== */}
      <section
        aria-labelledby="blog-heading"
        className="relative isolate overflow-hidden border-b border-border"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_55%_at_78%_-10%,color-mix(in_oklab,var(--brand-400)_28%,transparent),transparent_60%),radial-gradient(45%_35%_at_8%_0%,color-mix(in_oklab,var(--brand-500)_18%,transparent),transparent_60%)]"
        />

        <div className="container-page flex flex-col gap-6 pb-section-lg pt-section-lg lg:max-w-3xl">
          <p className="text-eyebrow">Threat-intel blog</p>
          <h1
            id="blog-heading"
            className="font-display text-display tracking-tight text-foreground"
          >
            How the <span className="block text-brand-500">pipeline ranked it, this week.</span>
          </h1>
          <p className="max-w-xl text-body-lg text-muted-foreground">
            {`Each post is one editorialised decision the ${brand.name} pipeline made this week:
            which CVE mattered, why it mattered against your surface, and what to do before the
            next publish. KEV, EPSS, and VulnCheck collaborate; you get the conclusion, not the
            three raw feeds.`}
          </p>
        </div>
      </section>

      {/* ===================== INDEX ===================== */}
      <section aria-labelledby="latest-heading" className="container-page section-lg scroll-mt-20">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-eyebrow">Latest posts</p>
            <h2
              id="latest-heading"
              className="mt-3 font-display text-h1 tracking-tight text-foreground"
            >
              {posts.length === 0
                ? 'No posts yet.'
                : `${posts.length} ${posts.length === 1 ? 'post' : 'posts'} published.`}
            </h2>
          </div>
        </div>

        {posts.length === 0 ? (
          <p className="mt-6 max-w-prose text-body text-muted-foreground">
            The pipeline is between publishes. Check back after the next feed refresh, or jump into
            the trial workspace to see the same signal flowing into the dashboard.
          </p>
        ) : (
          <ul className="mt-10 grid gap-6">
            {posts.map((post) => (
              <li key={post.id}>
                <article className="group flex flex-col gap-3 border-b border-border pb-6 transition-colors last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                    <time dateTime={post.publishedAt.toISOString()}>
                      {post.publishedAt.toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </time>
                    {post.tags.length > 0 ? (
                      <ul className="flex flex-wrap items-center gap-1.5">
                        {post.tags.map((tag) => (
                          <li key={tag}>
                            <Badge
                              variant="outline"
                              className="font-mono text-[0.66rem] uppercase tracking-wider text-muted-foreground"
                            >
                              {tag}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <Link
                    href={`/blog/${post.slug}`}
                    className="font-display text-h3 tracking-tight text-foreground transition-colors group-hover:text-brand-500"
                  >
                    {post.title}
                  </Link>
                  <p className="max-w-prose text-body text-muted-foreground">{post.summary}</p>
                  <div>
                    <Link
                      href={`/blog/${post.slug}`}
                      className="text-small font-medium text-brand-500 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      Read the post →
                    </Link>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Structured data: Blog + ItemList so the index is parseable as a feed
          by BlogPosting-aware crawlers. Hand-inlined as JSX text (Next's
          metadata API only emits a handful of built-in types — Blog/ItemList
          aren't among them). JSON.stringify output only contains characters
          safe to live inside a <script> tag body. */}
      <script type="application/ld+json">{JSON.stringify(blogJsonLd)}</script>
      <script type="application/ld+json">{JSON.stringify(itemListJsonLd)}</script>
    </main>
  );
}
