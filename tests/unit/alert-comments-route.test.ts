// @polsia:user-owned — Source-string assertions for the per-alert comment
// thread on /alerts/[id]. Mirrors the alerts-export.test.ts posture: we
// read the route source files and assert that the surface matches the
// brief — no live DB, no Prisma import (data-plane rule).
//
// Coverage:
//   - GET orders chronologically ASC (oldest first).
//   - GET visibility is narrowed to "assignee sees all rows; everyone
//     else sees only their own posts" — the brief's "owner or
//     commenters" constraint.
//   - GET and POST both gate on `requireTeamRole('member')`.
//   - POST returns a 403 typed `{ error: 'not_assignee' }` when the
//     caller is not the alert's assignee (per-row check layered in app
//     code so 401/403/404 from the team gate stay opaque).
//   - Cross-team / not-found POST is a 404 (no existence leak).
//   - Body schema enforces trim, min(1), max(4000), strict object.
//   - `findFirst` on the GET selects `ownerId` so the assignee-check can
//     execute without a second query.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('/api/alerts/[id]/comments surface', () => {
  const routeSrc = readFileSync(resolve(root, 'src/app/api/alerts/[id]/comments/route.ts'), 'utf8');
  const contractsSrc = readFileSync(resolve(root, 'src/lib/contracts/alert-comments.ts'), 'utf8');
  const cardSrc = readFileSync(
    resolve(root, 'src/components/dashboard/alert-comments-card.tsx'),
    'utf8',
  );
  const detailSrc = readFileSync(
    resolve(root, 'src/components/dashboard/alert-detail-client.tsx'),
    'utf8',
  );

  it('GET gates on requireTeamRole("member")', () => {
    expect(routeSrc).toMatch(/requireTeamRole\(\s*['"]member['"]\s*\)/);
  });

  it('GET orders rows chronologically ASC (oldest first)', () => {
    expect(routeSrc).toMatch(/orderBy:\s*\{\s*createdAt:\s*['"]asc['"]/);
    expect(routeSrc).not.toMatch(/orderBy:\s*\{\s*createdAt:\s*['"]desc['"]/);
  });

  it('GET findFirst selects ownerId so the assignee-check is colocated', () => {
    expect(routeSrc).toMatch(/select:\s*\{\s*id:\s*true,\s*ownerId:\s*true\s*\}/);
  });

  it('GET assignee sees all rows; non-assignee is narrowed to own authorId', () => {
    expect(routeSrc).toMatch(/callerIsAssignee/);
    // The visibility predicate is a single-clause spread: assignee →
    // empty (sees everything); non-assignee → narrowed authorId filter.
    // The literal lives across newlines inside the where object so a
    // flexible `[\s\S]*?` is the right shape — strict `\s*` won't span.
    expect(routeSrc).toMatch(/\.\.\.\(callerIsAssignee[\s\S]*?authorId:/);
  });

  it('cross-team / missing alert GET returns opaque 404', () => {
    expect(routeSrc).toMatch(/not_found/);
    // The 404 path lives INSIDE the GET try block so a Prisma throw
    // doesn't leak existence via a 500 / 200.
    expect(routeSrc).toMatch(/status:\s*404/);
  });

  it('POST gates assignee with a TYPED 403 not_assignee', () => {
    expect(routeSrc).toMatch(/error:\s*['"]not_assignee['"]/);
    expect(routeSrc).toMatch(/status:\s*403/);
  });

  it('POST cross-team / missing alert is a 404 (no existence leak)', () => {
    // Cross-team POST must NOT surface the assignee 403 (which would
    // tell a non-owner caller "row exists, you're not the owner").
    expect(routeSrc).toMatch(/status:\s*404/);
  });

  it('locks method not allowed for non-GET/POST verbs', () => {
    expect(routeSrc).toMatch(/PUT\s*=\s*methodNotAllowed/);
    expect(routeSrc).toMatch(/PATCH\s*=\s*methodNotAllowed/);
    expect(routeSrc).toMatch(/DELETE\s*=\s*methodNotAllowed/);
  });

  it('body schema enforces trim + min(1) + max(4000) + strict object', () => {
    expect(contractsSrc).toMatch(/trim\(\)/);
    expect(contractsSrc).toMatch(/min\(1,\s*['"]Body cannot be empty\.['"]\)/);
    expect(contractsSrc).toMatch(/max\(4000,\s*['"]Body is too long\.['"]\)/);
    expect(contractsSrc).toMatch(/\.strict\(\)/);
  });

  it('response contracts are zod-typed and shared with the client island', () => {
    expect(contractsSrc).toMatch(/AlertCommentItem/);
    expect(contractsSrc).toMatch(/AlertCommentList/);
    expect(contractsSrc).toMatch(/AlertCommentCreateBody/);
  });

  it('client island renders RELATIVE timestamps via Intl.RelativeTimeFormat', () => {
    expect(cardSrc).toMatch(/Intl\.RelativeTimeFormat/);
    // The hidden absolute stamp rides on a `title` attribute so a hover
    // is verbatim ISO.
    expect(cardSrc).toMatch(/title=\{item\.createdAt\}/);
    // A now-state + 60s tick keeps visible ages from going stale.
    expect(cardSrc).toMatch(/(?:RELATIVE_TICK_MS|setInterval)/);
  });

  it('client island renders the optimistic note at the END (server is ASC)', () => {
    expect(cardSrc).toMatch(/\[\.\.\.prev\.items,\s*optimisticRow\]/);
  });

  it('client island POSTs via apiFetch with the AlertCommentItem schema', () => {
    expect(cardSrc).toMatch(/apiFetch/);
    expect(cardSrc).toMatch(/AlertCommentItemSchema\.parse/);
  });

  it('AlertCommentsCard is mounted BETWEEN FixSnippetCard and StakeholderSummaryCard', () => {
    const fixIdx = detailSrc.indexOf('<FixSnippetCard');
    const commentIdx = detailSrc.indexOf('<AlertCommentsCard');
    const stakeIdx = detailSrc.indexOf('<StakeholderSummaryCard');
    expect(fixIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeGreaterThan(fixIdx);
    expect(stakeIdx).toBeGreaterThan(commentIdx);
  });

  it('detail page server component does NOT import the comments data plane', () => {
    const pageSrc = readFileSync(resolve(root, 'src/app/(dashboard)/alerts/[id]/page.tsx'), 'utf8');
    // The page must remain a Server Component that exports metadata +
    // composes the client island; no AlertComment / prisma / fetch.
    expect(pageSrc).toMatch(/export\s+async\s+function\s+generateMetadata/);
    expect(pageSrc).not.toMatch(/prisma\.alertComment/);
    expect(pageSrc).not.toMatch(/['"]use server['"]/);
  });
});
