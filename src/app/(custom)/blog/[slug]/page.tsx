// @polsia:user-owned — public /blog/[slug] reader. Server Component with
// per-page metadata (POL-2616). Pure RSC, no client island, so Prisma is
// read directly via the @/lib/business/blog helpers — no /api handler is
// needed (per nextjs-data-plane/SKILL.md, /api is reserved for client
// islands and form submissions). Body is rendered through the typed
// safe-subset Markdown parser in @/lib/content/markdown (not a raw
// `\n\n → <p>` split) so bold/em/link tokens in the seed bodies reach
// the DOM as proper elements. The page also emits:
//   • a reading-time chip next to the publication date
//   • an on-article <footer> with last-updated + tag repeat
//   • a prev/next <Link> row carrying `rel="prev"` / `rel="next"`
//   • two independent JSON-LD blocks — Article + BreadcrumbList — so
//     Google's rich-result parser indexes them as separate entities.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { brand } from '@/lib/brand';
import {
  computeReadingTimeMinutes,
  getAdjacentPosts,
  getPostBySlug,
  type PublishedPostFull,
} from '@/lib/business/blog';
import { getRelatedSeedPosts } from '@/lib/business/blog-seed';
import { type InlineNode, parseMarkdown } from '@/lib/content/markdown';
import { siteName, siteUrl } from '@/lib/site';

async function loadPost(slug: string): Promise<PublishedPostFull> {
  const post = await getPostBySlug(slug);
  if (!post) notFound();
  // notFound()'s type is `never`, but TS doesn't narrow through `await`. Use an
  // explicit assertion that mirrors the runtime invariant.
  if (!post) throw new Error('unreachable');
  return post;
}

// Per-page metadata. Asymmetric openGraph type (`article` here, `website`
// on the index) signals rich-result eligibility for a single post. We
// intentionally exclude reading-time from OG/Twitter cards — the
// per-post surface's job is to render the article; the read-time chip
// is a reader-page affordance, not a metadata signal.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) {
    return {
      title: 'Post not found',
      alternates: {
        canonical: `/blog/${slug}`,
        types: { 'application/rss+xml': '/blog/rss.xml' },
      },
    };
  }
  const ogImages = post.ogImageUrl ? [{ url: post.ogImageUrl }] : [{ url: '/opengraph-image' }];
  return {
    title: post.title,
    description: post.summary,
    alternates: {
      canonical: `/blog/${post.slug}`,
      types: { 'application/rss+xml': '/blog/rss.xml' },
    },
    openGraph: {
      type: 'article',
      url: `/blog/${post.slug}`,
      title: post.title,
      description: post.summary,
      publishedTime: post.publishedAt.toISOString(),
      modifiedTime: post.updatedAt.toISOString(),
      authors: [siteName],
      tags: post.tags,
      images: ogImages,
    },
    twitter: {
      card: 'summary_large_image',
      title: post.title,
      description: post.summary,
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await loadPost(slug);
  const adjacent = await getAdjacentPosts(post);
  const related = getRelatedSeedPosts(post, 3);
  const minutes = computeReadingTimeMinutes(post.body);
  const blocks = parseMarkdown(post.body);

  // Article JSON-LD — `Article` (not `BlogPosting`) is the broader
  // schema.org type Google indexes for rich snippets across news and
  // blog surfaces.
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.summary,
    url: `${siteUrl}/blog/${post.slug}`,
    datePublished: post.publishedAt.toISOString(),
    dateModified: post.updatedAt.toISOString(),
    author: {
      '@type': 'Organization',
      name: siteName,
    },
    publisher: {
      '@type': 'Organization',
      name: siteName,
    },
    keywords: post.tags.join(', '),
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${siteUrl}/blog/${post.slug}`,
    },
  };

  // Breadcrumb JSON-LD — three ListItems: Home → Blog → Post. Split
  // from the Article block because Google's parser treats each
  // <script type="application/ld+json"> as an independent entity.
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${siteUrl}/blog` },
      {
        '@type': 'ListItem',
        position: 3,
        name: post.title,
        item: `${siteUrl}/blog/${post.slug}`,
      },
    ],
  };

  return (
    <main className="relative">
      {/* ===================== HEADER ===================== */}
      <section
        aria-labelledby="post-heading"
        className="relative isolate overflow-hidden border-b border-border"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(75%_60%_at_82%_-10%,color-mix(in_oklab,var(--brand-500)_24%,transparent),transparent_60%),radial-gradient(45%_40%_at_8%_10%,color-mix(in_oklab,var(--brand-400)_18%,transparent),transparent_60%)]"
        />

        <div className="container-page flex flex-col gap-6 pb-section-lg pt-section-lg lg:max-w-3xl">
          <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
            <Link
              href="/blog"
              className="font-medium text-brand-500 underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              ← All posts
            </Link>
            <span aria-hidden>·</span>
            <time dateTime={post.publishedAt.toISOString()}>
              {post.publishedAt.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
            {minutes > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span>{minutes} min read</span>
              </>
            ) : null}
          </div>

          <h1
            id="post-heading"
            className="font-display text-display tracking-tight text-foreground"
          >
            {post.title}
          </h1>

          <p className="max-w-2xl text-body-lg text-muted-foreground">{post.summary}</p>

          {post.tags.length > 0 ? (
            <ul aria-label="Tags" className="flex flex-wrap items-center gap-2">
              {post.tags.map((tag) => (
                <li key={tag}>
                  <Badge
                    variant="outline"
                    className="font-mono text-[0.7rem] uppercase tracking-wider text-muted-foreground"
                  >
                    {tag}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {/* ===================== BODY ===================== */}
      <section
        aria-label={`${brand.name} analysis`}
        className="container-page section-lg scroll-mt-20"
      >
        <article className="max-w-prose text-body-lg leading-relaxed text-foreground">
          {blocks.map((block) => (
            <p key={block.key} className="mt-6 first:mt-0">
              {block.children.map((node) => (
                <Inline key={node.key} node={node} />
              ))}
            </p>
          ))}
        </article>

        <footer className="mt-12 border-t border-border">
          <div className="flex flex-wrap items-center gap-3 py-8 text-small text-muted-foreground">
            <span>
              Last updated{' '}
              <time dateTime={post.updatedAt.toISOString()}>
                {post.updatedAt.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
            </span>
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
        </footer>
      </section>

      {/* ===================== PREV/NEXT ===================== */}
      {adjacent.previous || adjacent.next ? (
        <section aria-label="Continue reading" className="container-page section-sm scroll-mt-20">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {adjacent.previous ? (
              <Link
                href={`/blog/${adjacent.previous.slug}`}
                rel="prev"
                className="group flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-card p-6 transition-colors hover:border-brand-500/60"
              >
                <span className="text-eyebrow text-muted-foreground">← Previous</span>
                <span className="font-display text-h4 text-foreground transition-colors group-hover:text-brand-500">
                  {adjacent.previous.title}
                </span>
              </Link>
            ) : (
              <span aria-hidden />
            )}
            {adjacent.next ? (
              <Link
                href={`/blog/${adjacent.next.slug}`}
                rel="next"
                className="group flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-card p-6 text-right transition-colors hover:border-brand-500/60 sm:text-right"
              >
                <span className="text-eyebrow text-muted-foreground">Next →</span>
                <span className="font-display text-h4 text-foreground transition-colors group-hover:text-brand-500">
                  {adjacent.next.title}
                </span>
              </Link>
            ) : (
              <span aria-hidden />
            )}
          </div>
        </section>
      ) : null}

      {/* ===================== RELATED ===================== */}
      {related.length > 0 ? (
        <section
          aria-labelledby="related-heading"
          className="border-t border-border bg-muted/30 section-lg scroll-mt-20"
        >
          <div className="container-page">
            <p className="text-eyebrow">Continue reading</p>
            <h2
              id="related-heading"
              className="mt-3 font-display text-display tracking-tight text-foreground"
            >
              Related posts.
            </h2>
            <ul className="mt-10 grid gap-6 md:grid-cols-2">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    href={`/blog/${r.slug}`}
                    className="group flex h-full flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-card p-6 transition-colors hover:border-brand-500/60"
                  >
                    <time
                      dateTime={r.publishedAt.toISOString()}
                      className="text-eyebrow text-muted-foreground"
                    >
                      {r.publishedAt.toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                    <span className="font-display text-display tracking-tight text-foreground transition-colors group-hover:text-brand-500">
                      {r.title}
                    </span>
                    <p className="line-clamp-3 text-body-lg text-muted-foreground">{r.summary}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* Structured data — Article + BreadcrumbList, in two independent
          <script> blocks because Google's rich-result parser indexes them
          as separate entities. Hand-inlined as JSX text (Next's built-in
          metadata API only ships a handful of schema.org types; Article
          and BreadcrumbList aren't there for arbitrary MDX-shaped content).
          The JSON.stringify output only contains characters safe to live
          inside a <script> tag body, so no dangerouslySetInnerHTML. */}
      <script type="application/ld+json">{JSON.stringify(articleJsonLd)}</script>
      <script type="application/ld+json">{JSON.stringify(breadcrumbJsonLd)}</script>
    </main>
  );
}

// Local Inline switch — mirrors the render path in
// src/components/custom/changelog/changelog-list.tsx, but lives inline
// here because the changelog list ships as a client island (it needs
// to fetch + hydrate). The blog body is RSC-only, has zero interactivity,
// and stays SSR for crawlability, so re-implementing this 30-LoC switch
// inline is cheaper than routing the page through a shared client
// component just to reuse five JSX branches.
function Inline({ node }: { node: InlineNode }): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'br':
      return <br />;
    case 'strong':
      return (
        <strong className="font-semibold text-foreground">{renderChildren(node.children)}</strong>
      );
    case 'em':
      return <em className="italic">{renderChildren(node.children)}</em>;
    case 'link':
      return (
        <a
          href={node.href}
          rel="noopener noreferrer"
          className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
        >
          {renderChildren(node.children)}
        </a>
      );
  }
}

function renderChildren(children: InlineNode[]): ReactNode {
  return children.map((child) => <Inline key={child.key} node={child} />);
}
