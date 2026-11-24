// @polsia:user-owned — Read helpers for /blog + /blog/[slug]. Server-only; the
// pages are pure RSC so they call these directly without going through /api.
// Selects the slim column set each consumer needs to keep the wire payload
// bounded; `related` overlap-scores on shared tags and tie-breaks on
// publishedAt desc so a related strip stays deterministic even as posts
// accumulate.
//
// Build-time Prisma tables: the deploy pipeline runs `next build` BEFORE
// `prisma db push` (see polsia.toml), so the `Post` table does not yet
// exist when pages prerender. We catch the resulting P2021 ("table does
// not exist") and return safe fallbacks so the build finishes; after
// `db push` runs at startup the same calls see the real table.

import 'server-only';
import { prisma } from '@/lib/db';

export interface PublishedPostSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  publishedAt: Date;
  tags: string[];
}

function isMissingTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2021'
  );
}

// During `next build` the DB may be unreachable from the build sandbox
// (the production deploy reaches Neon, the build sandbox does not); we
// still want prerender to finish so the deploy can move on. Runtime
// reads propagate errors so a real outage is not silenced in prod.
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function swallowAtBuild(err: unknown): boolean {
  return isBuildPhase() || isMissingTable(err);
}

// Newest-first listing for the index page. Filters out drafts (null
// publishedAt) at the DB so the page doesn't have to.
export async function getPublishedPosts({
  limit = 20,
}: {
  limit?: number;
} = {}): Promise<PublishedPostSummary[]> {
  let rows: {
    id: string;
    slug: string;
    title: string;
    summary: string;
    publishedAt: Date | null;
    tags: string[];
  }[];
  try {
    rows = await prisma.post.findMany({
      where: { publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        publishedAt: true,
        tags: true,
      },
    });
  } catch (err) {
    if (swallowAtBuild(err)) return [];
    throw err;
  }
  // Prisma returns `publishedAt` as Date | null; filter to drop any rows
  // that slipped past the filter (null publishedAt can never reach the
  // select, but the type system keeps it optional).
  return rows.flatMap((r) =>
    r.publishedAt
      ? [
          {
            id: r.id,
            slug: r.slug,
            title: r.title,
            summary: r.summary,
            publishedAt: r.publishedAt,
            tags: r.tags,
          },
        ]
      : [],
  );
}

export interface PublishedPostFull extends PublishedPostSummary {
  body: string;
  updatedAt: Date;
  ogImageUrl: string | null;
}

// Single-post lookup for the reader page. Returns null on a miss so the
// page can `notFound()` instead of throwing through the layout.
export async function getPostBySlug(slug: string): Promise<PublishedPostFull | null> {
  let row: {
    id: string;
    slug: string;
    title: string;
    summary: string;
    body: string;
    publishedAt: Date | null;
    tags: string[];
    updatedAt: Date;
    ogImageUrl: string | null;
  } | null;
  try {
    row = await prisma.post.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        body: true,
        publishedAt: true,
        tags: true,
        updatedAt: true,
        ogImageUrl: true,
      },
    });
  } catch (err) {
    if (swallowAtBuild(err)) return null;
    throw err;
  }
  if (!row || !row.publishedAt) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    publishedAt: row.publishedAt,
    tags: row.tags,
    updatedAt: row.updatedAt,
    ogImageUrl: row.ogImageUrl,
  };
}

// Overlap-score on shared `tags`, excludes the current post, tie-breaks on
// newest-first. Pulls more than `limit` from the DB so a post with a thin
// tag intersection still finds at least one alternative.
export async function getRelatedPosts(
  current: PublishedPostFull,
  limit = 3,
): Promise<PublishedPostSummary[]> {
  if (current.tags.length === 0) {
    // No tags → fall back to recent posts (still excluding self).
    const rows = await getPublishedPosts({ limit: limit + 1 });
    return rows.filter((r) => r.id !== current.id).slice(0, limit);
  }
  let candidates: {
    id: string;
    slug: string;
    title: string;
    summary: string;
    publishedAt: Date | null;
    tags: string[];
  }[];
  try {
    candidates = await prisma.post.findMany({
      where: {
        publishedAt: { not: null },
        id: { not: current.id },
        tags: { hasSome: current.tags },
      },
      orderBy: { publishedAt: 'desc' },
      take: limit * 4,
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        publishedAt: true,
        tags: true,
      },
    });
  } catch (err) {
    if (swallowAtBuild(err)) return [];
    throw err;
  }
  const scored = candidates
    .map((c) => ({
      post: c,
      overlap: c.tags.filter((t) => current.tags.includes(t)).length,
      publishedAt: c.publishedAt ?? new Date(0),
    }))
    .sort((a, b) => b.overlap - a.overlap || b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, limit);
  return scored.flatMap((s) =>
    s.post.publishedAt
      ? [
          {
            id: s.post.id,
            slug: s.post.slug,
            title: s.post.title,
            summary: s.post.summary,
            publishedAt: s.post.publishedAt,
            tags: s.post.tags,
          },
        ]
      : [],
  );
}

// Reading-time estimate for the reader-page chip. Pure (no DB). 200 wpm
// is the conventional baseline for prose; the floor at 1 minute stops
// short bodies from rendering as "0 min read". Word split on any unicode
// whitespace so a Markdown body with bold/em/link tokens still counts
// the underlying words rather than the inflated token sequence.
export function computeReadingTimeMinutes(body: string): number {
  const words = body
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  return Math.max(1, Math.round(words / 200));
}

// Adjacent-post navigation for the prev/next row on the reader page.
// Returns the immediate `previous` (older by publishedAt desc → ascd) and
// `next` (newer) posts relative to `current`. Both `findFirst` calls run
// in parallel (`Promise.all`) so an adjacent lookup is one round-trip
// pair, not two serial queries. Build-time / missing-table errors are
// swallowed to a null pair so prerender survives; runtime reads
// propagate errors so a real outage is not silenced in prod.
export async function getAdjacentPosts(current: PublishedPostFull): Promise<{
  previous: PublishedPostSummary | null;
  next: PublishedPostSummary | null;
}> {
  type AdjacentRow = {
    id: string;
    slug: string;
    title: string;
    summary: string;
    publishedAt: Date | null;
    tags: string[];
  } | null;

  let previousRow: AdjacentRow;
  let nextRow: AdjacentRow;
  try {
    [previousRow, nextRow] = await Promise.all([
      prisma.post.findFirst({
        where: {
          publishedAt: { lt: current.publishedAt, not: null },
          id: { not: current.id },
        },
        orderBy: { publishedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          slug: true,
          title: true,
          summary: true,
          publishedAt: true,
          tags: true,
        },
      }),
      prisma.post.findFirst({
        where: {
          publishedAt: { gt: current.publishedAt, not: null },
          id: { not: current.id },
        },
        orderBy: { publishedAt: 'asc' },
        take: 1,
        select: {
          id: true,
          slug: true,
          title: true,
          summary: true,
          publishedAt: true,
          tags: true,
        },
      }),
    ]);
  } catch (err) {
    if (swallowAtBuild(err)) return { previous: null, next: null };
    throw err;
  }
  const toSummary = (r: AdjacentRow): PublishedPostSummary | null =>
    r?.publishedAt
      ? {
          id: r.id,
          slug: r.slug,
          title: r.title,
          summary: r.summary,
          publishedAt: r.publishedAt,
          tags: r.tags,
        }
      : null;
  return { previous: toSummary(previousRow), next: toSummary(nextRow) };
}
