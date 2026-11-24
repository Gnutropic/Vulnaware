// @polsia:user-owned — Idempotent sample-post seeder for /blog and
// /blog/[slug]. Seeds three long-form Markdown posts that exercise the
// safe-subset parser (bold, em, link) in @/lib/content/markdown so the
// rendered body has non-trivial structure and a non-trivial reading time.
// Idempotent: each insert is keyed on `slug` via `findUnique`; re-runs on
// the same DB are a no-op after the first pass. Tags come from the
// threat-intel taxonomy used by the scanner pipeline (kev, epss,
// vulncheck, sarif, compensating controls) so real posts seeded by the
// pipeline land in the same related-overlap graph as these samples.

import 'server-only';
import { prisma } from '@/lib/db';

interface BlogPostSeed {
  slug: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  /** ISO timestamp; preserved so the seed row's publication date is stable
   *  across re-runs (otherwise `Date.now()` would shift every cold seed). */
  publishedAt: Date;
}

// Markdown bodies — each paragraph is long-form prose that exercises the
// safe-subset parser (bolding, italics, links). Reading time stays above
// the 1-minute floor because `computeReadingTimeMinutes` returns
// `Math.max(1, Math.round(words / 200))`.
export const BLOG_POSTS: readonly BlogPostSeed[] = [
  {
    slug: 'getting-started-with-cve-triage',
    title: 'Getting started with CVE triage: a practical playbook',
    summary:
      'New CVEs arrive faster than any team can review. A repeatable triage workflow — keyed on KEV and asset exposure — turns the firehose into a ranked queue your team can actually work through.',
    publishedAt: new Date('2026-07-08T09:00:00Z'),
    tags: ['kev', 'epss', 'vulncheck', 'threat-intel'],
    body: [
      'The vulnerability disclosure firehose is a structural problem, not a workflow problem. New CVE identifiers publish every hour and the median enterprise security team has the bandwidth to actually action somewhere between five and fifteen findings per week. Without a system that _prunes_ the feed down to what matters against your specific environment, the team is reading news instead of doing work.',
      'Start by anchoring triage to two signals that already encode exploitation: the **CISA Known Exploited Vulnerabilities** catalog and the **EPSS** probability score from FIRST. KEV is the floor — anything listed there is being exploited in the wild right now, against a real target, in a real campaign. EPSS complements it with a forward-looking thirty-day probability of exploitation, which is the right question for everything that is not KEV-listed yet but has the profile to land there.',
      'A third layer helps with asset exposure: scope every CVE down to the assets you actually run. A critical RCE on a library your services do not import should not queue at the same priority as the same RCE on a library your payments service links directly. **Asset-to-CVE mapping** is the difference between a ranked queue and a ranked queue that is actually about _your_ surface. The mapping is also where compensating controls start to matter — a WAF in front of the affected endpoint reshapes the risk before the analyst ever opens a ticket.',
      'The second decision is ownership. Every CVE that survives pruning needs a named owner, a remediation target date, and a fallback plan if the patch lands late. The owner does not have to be the person who performs the remediation — usually the owner is the service owner who can pull the patch forward or accept the risk on behalf of the business. Without ownership, the queue fills up with Critical findings that nobody acts on, and the dashboard stops being trusted.',
      'A practical cadence: the triage pass runs **once per business day** at a fixed time. New high-confidence signals (KEV-listed, EPSS above your threshold, VulnCheck observed-in-the-wild) jump to the top and get owned the same day. Everything else accumulates into the next morning queue. Resist the temptation to triage on every CVE publication — that is the path back to reading news instead of doing work.',
      'Finally, write the disposition. Every CVE the team triages gets a one-paragraph note: what we decided, why, what compensating control we relied on if any, and when we will revisit. Six months later those notes are how the team explains a decision to a manager, an auditor, or a regulator, and they are how the next triage pass learns from the last one. The notes are the slowest part of the workflow and the highest-leverage artifact it produces.',
    ].join('\n\n'),
  },
  {
    slug: 'scoring-with-epss-and-kev',
    title: 'Scoring with EPSS and KEV: ranking CVEs that matter against your stack',
    summary:
      'EPSS and KEV answer different questions and most teams use only one of them. Layered correctly they collapse the queue from thousands of CVEs to the dozens your team can actually patch this week.',
    publishedAt: new Date('2026-07-15T10:00:00Z'),
    tags: ['epss', 'kev', 'vulncheck', 'threat-intel'],
    body: [
      '**KEV** and **EPSS** are easy to confuse because both are about exploitation, but they answer genuinely different questions. The CISA Known Exploited Vulnerabilities catalog answers a backward-looking question: _has this CVE been observed being exploited in the wild, by someone, against someone, recently?_ It is a curated list maintained by CISA with a strict inclusion bar, so being added is a strong signal but being absent is not a clean signal of safety — KEV cannot keep up with the publication rate on its own.',
      '**EPSS** answers a forward-looking question. For every published CVE, the Exploit Prediction Scoring System estimates the probability the CVE will be exploited within the next thirty days. EPSS is computed from observable signals (exploit code maturity, references in security tooling, discussion volume in technical forums) and produces a number between zero and one. The score is _not_ a severity rating and it is _not_ your risk; it is a single input into a score your team computes against your own exposure.',
      'The right way to layer them: KEV first, then EPSS as a tiebreaker on the rest. Anything KEV-listed sits at the top of the queue regardless of CVSS because real exploitation outweighs hypothetical severity. Below the KEV line, EPSS does the pruning — a CVE with EPSS below your threshold (0.1 is a reasonable starting point for most teams) usually does not deserve queue space. Above the threshold, EPSS becomes a sort: higher scores get owned sooner, lower scores accumulate to the next morning.',
      'This is where **compensating controls** enter the picture. A high-EPSS CVE that is fully mitigated by a WAF rule, network segmentation, or MFA on the affected control-plane path is not the same risk as one without those controls in place. The scoring model should subtract for each control that closes the exploit path before it reaches the affected code. The drop can be substantial — a CVE that would have ranked in the top ten can drop to the bottom half once you account for the upstream controls that already block the surface.',
      '**VulnCheck** is the third leg of the stool. Where KEV looks backward and EPSS looks forward, VulnCheck pulls telemetry-derived observation in near-real-time: which kits, which campaigns, which ransomware operators are using the CVE _this week_. A spike in VulnCheck observation on a CVE you have already queued moves it up. A spike on a CVE that has been sitting in the long tail is the signal to revisit your exposure scoping — either the exposure map is wrong, or the CVE just crossed into relevance for your stack.',
      'Put together, the three layers collapse a firehose of thousands of CVEs into a queue of dozens that your team can actually patch this week. The math is not subtle: KEV plus high EPSS plus an asset-to-CVE match plus a VulnCheck spike is a finding that gets owned the same day it lands. Everything else queues for the next morning, gets a target date, and gets written up. The ranking is reproducible, the ownership is named, and the queue stops being the bottleneck.',
    ].join('\n\n'),
  },
  {
    slug: 'teaming-vulncheck-telemetry-into-the-pipeline',
    title: 'Teaming VulnCheck telemetry into the pipeline without alert fatigue',
    summary:
      'VulnCheck observation spikes are early-warning signal — if you wire them naively into the queue you trade one firehose for another. Three rules keep the signal high-leverage without paging the on-call at 3am.',
    publishedAt: new Date('2026-07-22T11:00:00Z'),
    tags: ['vulncheck', 'kev', 'epss', 'threat-intel', 'sarif'],
    body: [
      'Live exploitation telemetry is the most operationally useful — and most operationally dangerous — data source a vulnerability team can wire in. The danger is not that the data is wrong; it is that the data is _right_ about far more CVEs than your team has bandwidth to act on. A naive integration lights up the queue every time a researcher posts a working proof-of-concept, and within a week the queue is back to unread news. The trick is to wire the signal in layers, with each layer gated on a confirmation step before it pages anyone.',
      'The first gate is **scope**. VulnCheck observation means something different against a CVE that affects one of your services and against a CVE that affects nothing in your stack. The platform keeps an asset-to-CVE map computed from your real inventory (linked from CI artefacts, scanned from cloud accounts, imported via [the SARIF upload flow](/blog/getting-started-with-cve-triage)), and a spike without an asset match is logged to the daily triage report but does not move any queue position. Most of the spam in a raw vulnerability feed comes from this bucket, and removing it cuts volume by an order of magnitude.',
      'The second gate is **EPSS and KEV corroboration**. A spike by itself is interesting. A spike on a CVE that is also high-EPSS or KEV-listed is _actionable_. A spike on a CVE that is also high-EPSS, KEV-listed, and matches an exposed asset is the same alert tier a Critical infrastructure finding would fire — the platform marks it as such and routes it to the on-call with the pre-computed remediation plan attached. The platform never pages on a spike alone; it pages only when the corroboration gates line up.',
      'The third gate is **rate limiting**. Even with the first two gates in place, the queue has a steady-state volume that the team needs to absorb. The platform caps per-day queue additions from observation spikes at a configurable threshold (default ten) so a single noisy day cannot shove twenty findings past the regular triage cadence. Anything above the cap accumulates into the next-morning overview with a clear lag annotation — the team reviews them in batch instead of running from page to page.',
      '_Configuration matters more than the platform itself._ The defaults work for most teams but not for all. A platform team running customer-facing infrastructure probably wants the corroboration gates cranked aggressively because every spike against exposed services is a real risk. A back-office internal-tools team can dial them back because the same spike is unlikely to reach a meaningful surface for them. The platform exposes the threshold cluster — EPSS cutoff, scope strictness, daily spike cap — as a single workspace settings page so security leads can tune without re-deploying.',
      'Finally, the **weekly retro**. Every Friday the platform produces a one-page summary: how many spikes fired, how many survived the corroboration gates, how many resulted in a patched finding, and how many were closed without patching because of an upstream **compensating control**. The retro is the artifact the team uses to tune the threshold cluster for the next week, and it is the artifact an auditor asks for when they want to know _why_ a given alert fired and what happened next. Six months of retros are how the team demonstrates a real vulnerability programme, instead of a firehose-and-spray setup that looks better in a dashboard than it works in practice.',
    ].join('\n\n'),
  },
] as const;

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

// Idempotent: each insert is keyed on `slug` via `findUnique`; re-runs on
// the same DB are a no-op after the first pass. `Promise.all` parallelises
// the per-slug check+insert so a cold-DB seed pass costs three round-trips
// in parallel rather than six in series. Build-time `findUnique`/`create`
// errors are swallowed at the per-slug level; a single missing-table
// error during the build phase quietly no-ops that slug and the loop
// continues (the /blog page guard will retry at runtime, after the
// table exists).
async function upsertSeed(seed: BlogPostSeed): Promise<void> {
  try {
    const existing = await prisma.post.findUnique({
      where: { slug: seed.slug },
      select: { id: true },
    });
    if (existing) return;
    await prisma.post.create({
      data: {
        slug: seed.slug,
        title: seed.title,
        summary: seed.summary,
        body: seed.body,
        publishedAt: seed.publishedAt,
        tags: [...seed.tags],
      },
    });
  } catch (err) {
    if (isBuildPhase() || isMissingTable(err)) return;
    throw err;
  }
}

// Build-time safety: `next build` runs BEFORE `prisma db push` (see
// polsia.toml), so the `Post` table does not yet exist during prerender.
// We swallow P2021 (table missing) AND any DB error during the build
// phase — the /blog page guard will retry at runtime, after the table
// exists.
export async function seedBlogSample(): Promise<void> {
  await Promise.all(BLOG_POSTS.map(upsertSeed));
}

// Const-backed related-posts lookup for the /blog/[slug] reader page.
// Mirrors the overlap-then-recency logic of `getRelatedPosts` in
// `@/lib/business/blog`, but reads from the in-memory `BLOG_POSTS`
// literal so the related strip is build-safe by construction (no DB,
// no P2021 guard, no `isBuildPhase()` branch). Returns a slim shape
// missing `id` because the seed has no DB-assigned identifier — the
// page keys cards on `slug` instead.
export function getRelatedSeedPosts(
  current: { slug: string; tags: string[] },
  limit = 2,
): { slug: string; title: string; summary: string; publishedAt: Date; tags: string[] }[] {
  const others = BLOG_POSTS.filter((p) => p.slug !== current.slug);
  if (current.tags.length === 0) {
    return [...others]
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, limit)
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        summary: p.summary,
        publishedAt: p.publishedAt,
        tags: [...p.tags],
      }));
  }
  return others
    .map((p) => ({
      post: p,
      overlap: p.tags.filter((t) => current.tags.includes(t)).length,
    }))
    .sort(
      (a, b) =>
        b.overlap - a.overlap || b.post.publishedAt.getTime() - a.post.publishedAt.getTime(),
    )
    .slice(0, limit)
    .map((s) => ({
      slug: s.post.slug,
      title: s.post.title,
      summary: s.post.summary,
      publishedAt: s.post.publishedAt,
      tags: [...s.post.tags],
    }));
}
