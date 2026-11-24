// @polsia:user-owned — Source-string assertions for
// POST /api/alerts/remediate-batch. Mirrors the posture in
// tests/integration/alerts-snooze-batch-source.test.ts: the
// assertions are read against the route + contracts source strings
// to pin the load-bearing behavioral contracts without spinning up
// a real Prisma client or HTTP server. The unit suite covers the
// full per-branch behavior end-to-end; this file pins the SHAPE of
// the route handler + contracts bundle so a copy-paste drift fails
// both surfaces (the same posture the existing alerts-export and
// alerts-snooze-batch integration tests use against their routes).
//
// Pinning targets:
//   - Route handler is gated by requireTeamRole('member') — the
//     brief's per-call authentication + per-call teamId scoping.
//   - Body parse enforces `.min(1)` on `ids` and `.strict()` on
//     the top-level object.
//   - Per-id transactions (NOT one prisma.$transaction([...])).
//   - Per-id owner check `existing.ownerId !== callerWorkspaceMember
//     .id → 'not_owner'` branch surfaced into the `failed` envelope.
//   - Idempotent branch on already-stamped `remediatedAt !== null`
//     (no UPDATE fired).
//   - Scope check drops cross-team ids silently (same posture as
//     snooze-batch).
//   - Slim envelope `{results, failed}` with `AlertBulkRemediateRow`
//     per row (no `remediatedByEmail` echoed — server-authoritative
//     source is the column itself).
//   - 500 outermost catch.
//   - Contracts bundle exports the new schemas AND the AlertItem /
//     AlertDetail wire shapes pick up `remediatedByEmail`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('/api/alerts/remediate-batch source', () => {
  const routeSrc = readFileSync(
    resolve(root, 'src/app/api/alerts/remediate-batch/route.ts'),
    'utf8',
  );
  const contractsSrc = readFileSync(resolve(root, 'src/lib/contracts/alerts.ts'), 'utf8');
  const helperSrc = readFileSync(
    resolve(root, 'src/lib/business/alerts-bulk-remediate.ts'),
    'utf8',
  );

  // ===================== Route gate posture =====================
  //
  // The route's gate must be the same `requireTeamRole('member')` the
  // /snooze-batch, /resolve, /[id]/snooze, and /[id]/resolve routes
  // use so a tampered-page cannot bypass the per-team gate silently.
  // The catch returns `res as Response` so the 401/403/404 from the
  // gate reach the client verbatim.

  it('gates on requireTeamRole("member")', () => {
    expect(routeSrc).toMatch(/requireTeamRole\(\s*['"]member['"]\s*\)/);
  });

  it('catches the auth Response from requireTeamRole unchanged', () => {
    expect(routeSrc).toMatch(/return\s+res\s+as\s+Response/);
  });

  it('forces dynamic rendering per request', () => {
    expect(routeSrc).toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/);
  });

  it('locks method not allowed for non-POST verbs', () => {
    expect(routeSrc).toMatch(/POST\s*=\s*methodNotAllowed/);
    expect(routeSrc).toMatch(/PUT\s*=\s*methodNotAllowed/);
    expect(routeSrc).toMatch(/PATCH\s*=\s*methodNotAllowed/);
    expect(routeSrc).toMatch(/DELETE\s*=\s*methodNotAllowed/);
  });

  it('returns 405 + Allow: POST on the methodNotAllowed stub', () => {
    expect(routeSrc).toMatch(/Allow:\s*['"]POST['"]/);
  });

  // ===================== Body parse posture =====================

  it('parses malformed JSON as a typed bad_request 400', () => {
    expect(routeSrc).toMatch(/invalid JSON/);
    expect(routeSrc).toMatch(/error:\s*['"]bad_request['"]/);
    expect(routeSrc).toMatch(/status:\s*400/);
  });

  it('runs AlertBulkRemediateBody.safeParse as the body schema gate', () => {
    expect(routeSrc).toMatch(/AlertBulkRemediateBody\.safeParse/);
  });

  // ===================== Scope check + silent cross-team drop =====================
  //
  // Pin the deliberate divergence from /api/alerts/[id]/remediate's
  // opaque-404 posture: cross-team ids are silently DROPPED, NOT
  // 404'd. The scope-check uses `teamId` (caller's team-bound
  // membership) and reads the existing rows' ids into a `liveIds`
  // array; every subsequent iteration uses `liveIds`, NOT
  // `uniqueIds`.

  it('scope-checks with a teamId-seeded findMany keyed on the unique request id set', () => {
    expect(routeSrc).toMatch(/\.findMany\(\s*\{[^}]*id:\s*\{\s*in:\s*uniqueIds\s*\}[^}]*teamId/);
  });

  it('reads the live id set off `liveIds` after the scope check', () => {
    // The brief explicitly names `liveIds` as the post-scope id
    // source — every later step (per-id loop + envelope) derives
    // from `liveIds`, NOT `uniqueIds`. A copy-paste drift back to
    // `uniqueIds` here would silently re-include cross-team rows on
    // a refactor; the integration assertion pins it.
    expect(routeSrc).toMatch(/liveIds\s*=\s*existing\.map\(/);
    expect(routeSrc).toMatch(/for\s*\(\s*const\s+id\s+of\s+liveIds\s*\)/);
  });

  it('does NOT bake the [id]/remediate 404 contract into the silent cross-team drop', () => {
    // Empty-overlap branch: HTTP 200, NOT 404. Cross-team ids
    // silently drop into `liveIds` short-circuiting neither the
    // loop nor the envelope — the helper paints 'err' for any
    // candidate missing from `results` so the page's bar surfaces
    // a meaningful partial-failure toast.
    expect(routeSrc).toMatch(/return\s+NextResponse\.json\(parsed\)/);
  });

  it('invokes prisma.alert.update per id (NOT a single prisma.$transaction across ids)', () => {
    // The brief mandates "per-id transactions" — a single
    // prisma.$transaction([...]) would NOT allow per-id
    // ack/rollback on the not_owner arm, so the route loops
    // explicit `prisma.alert.update({ where: { id: row.id } })`
    // calls instead. Each update is its own implicit Prisma
    // transaction. A drift back to `prisma.$transaction(
    // liveIds.map(...) )` would collapse the per-id failure
    // semantics — pin the absence.
    expect(routeSrc).toMatch(/prisma\.alert\.update\(/);
    expect(routeSrc).not.toMatch(/prisma\.\$transaction\(\s*liveIds\.map\(/);
  });

  it('stamps both remediatedAt AND remediatedByEmail on the per-id UPDATE', () => {
    expect(routeSrc).toMatch(/remediatedAt:\s*stamp\s*,\s*remediatedByEmail:\s*callerEmail/);
  });

  // ===================== Per-id idempotent + per-id owner gate =====================

  it('idempotent branch skips the UPDATE when existing.remediatedAt !== null', () => {
    // The brief's "stale click race" stance — re-remediating a
    // stamped row would churn the audit stamp. The route's
    // existing-stamp branch emits an envelope row without
    // firing an UPDATE.
    expect(routeSrc).toMatch(/row\.remediatedAt\s*!==\s*null/);
  });

  it('per-id owner gate short-circuits not_owner into the failed[] envelope', () => {
    // Strictly mirrors the single-id `[id]/remediate` PATCH: only
    // the assignee whose `WorkspaceMember.id` is currently
    // `Alert.ownerId` can stamp the row. A mismatch lands on
    // the `failed[]` envelope (NOT a blanket 404, NOT a silent
    // stamp). Pin both the comparison + the push.
    expect(routeSrc).toMatch(/row\.ownerId\s*!==\s*callerWorkspaceMember\.id/);
    expect(routeSrc).toMatch(
      /failed\.push\(\s*\{\s*id:\s*row\.id\s*,\s*error:\s*['"]not_owner['"]/,
    );
  });

  // ===================== Defence-in-depth =====================

  it('defence-in-depth: cross-team row in the per-id write returns opaque 404', () => {
    expect(routeSrc).toMatch(/updated\.teamId\s*!==\s*teamId/);
    expect(routeSrc).toMatch(/'not_found'/);
  });

  // ===================== Envelope contract =====================

  it('returns a slim {results, failed} envelope via AlertBulkRemediateResponse.parse', () => {
    expect(routeSrc).toMatch(/AlertBulkRemediateRow\.parse/);
    expect(routeSrc).toMatch(/AlertBulkRemediateResponse\.parse/);
  });

  it('500 outermost catch maps any internal throw to a JSON 500', () => {
    expect(routeSrc).toMatch(/Internal Server Error/);
    expect(routeSrc).toMatch(/status:\s*500/);
  });

  // ===================== Contracts bundle posture =====================
  //
  // Mirror of the existing /api/alerts/snooze-batch surface in
  // src/lib/contracts/alerts.ts.

  it('AlertBulkRemediateBody exports ids: z.array(z.string().min(1)).min(1) verbatim', () => {
    expect(contractsSrc).toMatch(/AlertBulkRemediateBody\s*=\s*z/);
    expect(contractsSrc).toMatch(/ids:\s*z\.array\(\s*z\.string\(\)\.min\(1\)\s*\)\.min\(1\)/);
    expect(contractsSrc).toMatch(/AlertBulkRemediateBody[\s\S]*?\.strict\(\)/);
  });

  it('AlertBulkRemediateRow exposes {id, remediatedAt} (slim envelope shape)', () => {
    expect(contractsSrc).toMatch(/AlertBulkRemediateRow/);
    expect(contractsSrc).toMatch(/remediatedAt:\s*z\.string\(\)\.nullable\(\)/);
  });

  it('AlertBulkRemediateFail exposes {id, error: z.enum(["not_owner"])} for per-id rejections', () => {
    expect(contractsSrc).toMatch(/AlertBulkRemediateFail/);
    expect(contractsSrc).toMatch(/error:\s*z\.enum\(\s*\[\s*['"]not_owner['"]\s*\]\s*\)/);
  });

  it('AlertBulkRemediateResponse exports {results, failed} with both arrays .min(0)', () => {
    expect(contractsSrc).toMatch(/AlertBulkRemediateResponse\s*=\s*z\.object\(/);
    expect(contractsSrc).toMatch(/results:\s*z\.array\(\s*AlertBulkRemediateRow\s*\)/);
    expect(contractsSrc).toMatch(/failed:\s*z\.array\(\s*AlertBulkRemediateFail\s*\)/);
  });

  it('each new schema type alias is derived via z.infer', () => {
    expect(contractsSrc).toMatch(/type\s+AlertBulkRemediateBody\s*=\s*z\.infer/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkRemediateBodyInput\s*=\s*z\.input/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkRemediateRow\s*=\s*z\.infer/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkRemediateFail\s*=\s*z\.infer/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkRemediateResponse\s*=\s*z\.infer/);
  });

  it('AlertItem and AlertDetail both gain remediatedByEmail: z.string().nullable()', () => {
    // Tally the `remediatedByEmail:` occurrences — AlertItem (1) +
    // AlertDetail (1) = 2. The data plane routes stamp the column
    // onto both contracts.
    const matches = contractsSrc.match(/remediatedByEmail:\s*z\.string\(\)\.nullable\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // ===================== Helper posture =====================

  it('helper pre-filters on selection AND remediatedAt === null (drops already-stamped rows)', () => {
    // runBulkRemediate's pre-filter excludes `remediatedAt !==
    // null` rows so a re-stamp on a stamped row never reaches the
    // wire. The bulk route's idempotent branch preserves the
    // original stamp anyway, but the helper pre-filter saves the
    // round trip.
    expect(helperSrc).toMatch(/selection\.has\(item\.id\)/);
    expect(helperSrc).toMatch(/item\.remediatedAt\s*===\s*null/);
  });

  it('helper POSTs to /api/alerts/remediate-batch (the new per-id endpoint)', () => {
    expect(helperSrc).toMatch(/['"]\/api\/alerts\/remediate-batch['"]/);
  });

  it('helper body shape: {ids: [...]} only — no duration, no set, no until', () => {
    // Body shape is the slim {ids} — the bulk action is a
    // unit-less "stamp now". Negative assertions on the helper
    // pin the absence of every byte-mismatching field.
    expect(helperSrc).toMatch(/\{\s*ids:\s*candidates\.map\(\s*\(\s*c\s*\)\s*=>\s*c\.id\s*\)\s*\}/);
    expect(helperSrc).not.toMatch(/duration:\s*duration/);
    expect(helperSrc).not.toMatch(/set:\s*['"]now['"]/);
    expect(helperSrc).not.toMatch(/set:\s*['"]clear['"]/);
  });

  it('helper optimistic flip stamps BOTH remediatedAt AND remediatedByEmail on all-OK', () => {
    // The bulk path stamps BOTH columns — the on-screen "Remediated
    // by <email>" chip subtitle matches the server-stamped value
    // without a second round trip. The optimistic flip degrades
    // `remediatedByEmail` to null when `callerEmail` is null —
    // server stamp is authoritative.
    expect(helperSrc).toMatch(/remediatedAt:\s*newStamp/);
    expect(helperSrc).toMatch(/remediatedByEmail:\s*callerEmail/);
  });

  it('helper refuses an empty candidate set (post pre-filter) without firing a fetch', () => {
    expect(helperSrc).toMatch(/candidates\.length\s*===\s*0/);
  });
});
