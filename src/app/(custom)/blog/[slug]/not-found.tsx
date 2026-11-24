// @polsia:user-owned — soft 404 for missing /blog/[slug]. Renders inside the
// root layout so <SiteNav /> and <SiteFooter /> still frame it (the brief's
// "nav still works" requirement). Pure static markup, no data fetch.

import Link from 'next/link';

export default function BlogPostNotFound() {
  return (
    <main className="relative">
      <section
        aria-labelledby="missing-post-heading"
        className="container-page flex flex-col gap-6 pb-section-lg pt-section-lg lg:max-w-3xl"
      >
        <div className="flex items-center gap-3 text-caption text-muted-foreground">
          <Link
            href="/blog"
            className="font-medium text-brand-500 underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            ← Back to all posts
          </Link>
        </div>

        <p className="text-eyebrow">404</p>
        <h1
          id="missing-post-heading"
          className="font-display text-display tracking-tight text-foreground"
        >
          Post not found.
        </h1>

        <p className="max-w-2xl text-body-lg text-muted-foreground">
          These posts are indexed by slug — the one you requested isn't published yet, or the link
          is from an older URL.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link
            href="/blog"
            className="font-medium text-brand-500 underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Browse all posts →
          </Link>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <Link
            href="/"
            className="font-medium text-brand-500 underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
