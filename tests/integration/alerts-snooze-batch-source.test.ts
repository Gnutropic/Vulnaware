// @polsia:user-owned — Source-string assertions for
// POST /api/alerts/snooze-batch. Mirrors the posture in
// tests/integration/alerts-export.test.ts: the assertions are
// read against the route + contracts source strings to pin the
// load-bearing behavioral contracts without spinning up a real
// Prisma client or HTTP server. The unit suite covers the full
// per-branch behavior end-to-end; this file pins the SHAPE of the
// route handler + contracts bundle so a copy-paste drift fails
// both surfaces (the same posture the existing alerts-export
// integration test uses against the CSV export).
//
// Pinning targets:
//   - Route handler is gated by requireTeamRole('member') — the
//     brief's per-call authentication + per-call teamId scoping.
//   - Body parse enforces `.min(1)` on `ids` and `.strict()` on
//     the top-level object.
//   - Single `prisma.$transaction` writes the snooze window in
//     one atomic fan-out.
//   - `liveIds` is the scope-checked, team-bounded id set — every
//     post-scope step reads from `liveIds`, NOT the request's raw
//     `ids`/`uniqueIds`. Cross-team ids are silently dropped from
//     both the transaction and the envelope; HTTP remains 200.
//   - Idempotent refresh — the transaction unconditionally stamps
//     `snoozedUntil = stamp` on every row; no prior-value gate.
//   - Defence-in-depth — any returned row whose `teamId !== ctx
//     .membership.teamId` → opaque 404.
//   - WINDOW_MS table exposes the 1d / 3d / 7d / 30d windows verbatim
//     so a future widening cascades through a single source of
//     truth (shared with the single-id /snooze route).
//   - Contracts bundle exports the new schemas AND promotes
//     `SnoozeDuration` to a top-level const so both bodies can
//     reference it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('/api/alerts/snooze-batch source', () => {
  const routeSrc = readFileSync(resolve(root, 'src/app/api/alerts/snooze-batch/route.ts'), 'utf8');
  const contractsSrc = readFileSync(resolve(root, 'src/lib/contracts/alerts.ts'), 'utf8');
  const helperSrc = readFileSync(resolve(root, 'src/lib/business/alerts-bulk-snooze.ts'), 'utf8');

  // ===================== Route gate posture =====================
  //
  // The route's gate must be the same `requireTeamRole('member')` the
  // /resolve, /[id]/snooze, and /[id]/resolve routes use so a
  // tampered-page cannot bypass the per-team gate silently. The
  // catch returns `res as Response` so the 401/403/404 from the
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

  it('runs AlertBulkSnoozeBody.safeParse as the body schema gate', () => {
    expect(routeSrc).toMatch(/AlertBulkSnoozeBody\.safeParse/);
  });

  // ===================== Window table =====================
  //
  // Mirror of `src/app/api/alerts/[id]/snooze/route.ts`'s
  // `WINDOW_MS` definition. The bulk route and the single-id
  // route must NOT drift the window table (different snooze
  // durations on the two routes would be a UX bug — a row
  // snoozed from /alerts/[id] for "7d" can't surface on /alerts
  // stamped with a 1d window after a bulk re-stamp).

  it('declares the WINDOW_MS table from DAY_MS with the 1d/3d/7d/30d arms', () => {
    expect(routeSrc).toMatch(/DAY_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(routeSrc).toMatch(/['"]1d['"]\s*:\s*DAY_MS/);
    expect(routeSrc).toMatch(/['"]3d['"]\s*:\s*3\s*\*\s*DAY_MS/);
    expect(routeSrc).toMatch(/['"]7d['"]\s*:\s*7\s*\*\s*DAY_MS/);
    expect(routeSrc).toMatch(/['"]30d['"]\s*:\s*30\s*\*\s*DAY_MS/);
  });

  // ===================== Scope check + silent cross-team drop =====================
  //
  // Pin the deliberate divergence from /api/alerts/resolve's
  // opaque-404 posture: cross-team ids are silently DROPPED, NOT
  // 404'd. The scope-check uses `teamId` (caller's team-bound
  // membership) and reads the existing rows' ids into a `liveIds`
  // array; every subsequent step — transaction + envelope — uses
  // `liveIds`, NOT `uniqueIds`.

  it('scope-checks with a teamId-seeded findMany keyed on the unique request id set', () => {
    expect(routeSrc).toMatch(/\.findMany\(\s*\{[^}]*id:\s*\{\s*in:\s*uniqueIds\s*\}[^}]*teamId/);
  });

  it('reads the live id set off `liveIds` after the scope check', () => {
    // The brief explicitly names `liveIds` as the post-scope id
    // source — every later step (transaction + envelope) derives
    // from `liveIds`, NOT `uniqueIds`. A copy-paste drift back to
    // `uniqueIds` here would silently re-include cross-team rows on
    // a refactor; the integration assertion pins it.
    expect(routeSrc).toMatch(/liveIds\s*=\s*existing\.map\(/);
    expect(routeSrc).toMatch(/liveIds\.map\(/);
  });

  it('does NOT bake the bulk-resolve 404 contract into the empty-overlap branch', () => {
    // The route reads `liveIds = existing.map(...)` and returns the
    // envelope with `liveIds` as the source. When every requested
    // id is cross-team/missing, the scope-check pass returns no
    // rows, `liveIds` is `[]`, the transaction is skipped, and the
    // envelope is `{results: []}` — HTTP 200. A copy-paste drift
    // from /api/alerts/resolve (which 404s on cross-team) would
    // re-introduce a `'not_found'` 404 here — pin the absence.
    expect(routeSrc).toMatch(/liveIds\.length\s*===\s*0/);
    // Cross-team drop branch: HTTP 200, NOT 404. Assert that the
    // route's `NextResponse.json` for the success path wraps
    // `AlertBulkSnoozeResponse.parse(...)` with no status override.
    expect(routeSrc).toMatch(/return\s+NextResponse\.json\(parsed\)/);
  });

  it('invokes prisma.$transaction with the array-of-promises form', () => {
    expect(routeSrc).toMatch(/prisma\.\$transaction\(\s*liveIds\.map\(/);
  });

  it('idempotent refresh: writes snoozedUntil = stamp unconditionally (no prior-value gate)', () => {
    // The route stamps `snoozedUntil: stamp` directly — there is no
    // `if (existing.snoozedUntil == null)` or similar prior-value
    // gate. A future drift that adds a no-op branch on already-
    // snoozed rows would silently skip re-applied gestures; pin it.
    expect(routeSrc).toMatch(/snoozedUntil:\s*stamp/);
  });

  // ===================== Defence-in-depth =====================

  it('defence-in-depth: cross-team row in the transaction result returns opaque 404', () => {
    expect(routeSrc).toMatch(/row\.teamId\s*!==\s*teamId/);
    expect(routeSrc).toMatch(/'not_found'/);
  });

  // ===================== Envelope contract =====================

  it('returns a slim {results: AlertBulkSnoozeRow[]} envelope', () => {
    expect(routeSrc).toMatch(/AlertBulkSnoozeRow\.parse/);
    expect(routeSrc).toMatch(/AlertBulkSnoozeResponse\.parse/);
  });

  it('500 outermost catch maps any internal throw to a JSON 500', () => {
    expect(routeSrc).toMatch(/Internal Server Error/);
    expect(routeSrc).toMatch(/status:\s*500/);
  });

  // ===================== Contracts bundle posture =====================
  //
  // Mirror of the existing /api/alerts/resolve surface in
  // src/lib/contracts/alerts.ts. The bulk snooze schemas share the
  // top-level `SnoozeDuration` literal with the [id]/snooze body
  // so a future widening cascades through one source.

  it('promotes SnoozeDuration to a top-level const (NOT nested inside a union)', () => {
    // The brief pins the SnoozeDuration export as a top-level
    // `export const SnoozeDuration = z.enum(['1d', '3d', '7d', '30d'])`,
    // so both `[id]/snooze` and `snooze-batch` bodies read the same
    // literal. A drift that nests it inside the union would force a
    // duplicate `z.enum` and break the lockstep guarantee. The 3d
    // arm flows from the /alerts floating bulk-bar popover (1d / 3d
    // / 7d / 30d picker) so a future drift back to the 3-arm set
    // fails this assertion and the call site surfaces schema drift.
    expect(contractsSrc).toMatch(
      /export\s+const\s+SnoozeDuration\s*=\s*z\.enum\(\s*\[\s*['"]1d['"]\s*,\s*['"]3d['"]\s*,\s*['"]7d['"]\s*,\s*['"]30d['"]\s*\]/,
    );
  });

  it('AlertBulkSnoozeBody exports a union of {ids, duration} + {ids, until} arms', () => {
    // The bulk body is a discriminated union mirroring
    // AlertSnoozeBody: the duration arm carries the shared
    // SnoozeDuration literal, the until arm carries the client-
    // supplied ISO. Both arms are .strict() AND share an `ids:
    // z.array(z.string().min(1)).min(1)` shape. Pin the union +
    // both arms so a future drift that drops the until arm fails
    // here BEFORE the wire breaks (the floating bulk-bar's
    // custom-date popover entry emits the until arm on apply).
    expect(contractsSrc).toMatch(/AlertBulkSnoozeBody\s*=\s*z\.union\(/);
    expect(contractsSrc).toMatch(/ids:\s*z\.array\(\s*z\.string\(\)\.min\(1\)\s*\)\.min\(1\)/);
    expect(contractsSrc).toMatch(/duration:\s*SnoozeDuration/);
    expect(contractsSrc).toMatch(/until:\s*z\.union\(/);
    expect(contractsSrc).toMatch(/AlertBulkSnoozeBody[\s\S]*?\.strict\(\)/);
  });

  it('AlertBulkSnoozeRow exposes {id, snoozedUntil} (slim envelope shape)', () => {
    expect(contractsSrc).toMatch(/AlertBulkSnoozeRow/);
    expect(contractsSrc).toMatch(/snoozedUntil:\s*z\.string\(\)\.nullable\(\)/);
  });

  it('AlertBulkSnoozeResponse exports {results: AlertBulkSnoozeRow[]}', () => {
    expect(contractsSrc).toMatch(/AlertBulkSnoozeResponse\s*=\s*z\.object\(/);
    expect(contractsSrc).toMatch(/results:\s*z\.array\(\s*AlertBulkSnoozeRow\s*\)/);
  });

  it('each new schema type alias is derived via z.infer', () => {
    expect(contractsSrc).toMatch(/type\s+AlertBulkSnoozeBody\s*=\s*z\.infer/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkSnoozeBodyInput\s*=\s*z\.input/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkSnoozeRow\s*=\s*z\.infer/);
    expect(contractsSrc).toMatch(/type\s+AlertBulkSnoozeResponse\s*=\s*z\.infer/);
  });

  // ===================== Helper posture =====================
  //
  // The helper has three deltas from runBulkResolve:
  //   1. No status / snooze-onset pre-filter — every selected id
  //      is a candidate (idempotent-refresh contract).
  //   2. ONE POST to /api/alerts/snooze-batch with `{ids, duration}`.
  //   3. Optimistic flip stamps ONLY `snoozedUntil` on every
  //      targeted id on all-OK — no status flip.

  it('helper pre-filters ONLY by selection membership (no status / snooze-onset drop)', () => {
    // runBulkResolve's pre-filter excludes `status === 'resolved'`
    // and future-snoozed ids; runBulkSnooze's pre-filter must NOT
    // do either so re-applying snooze refreshes the window.
    expect(helperSrc).toMatch(/selection\.has\(item\.id\)/);
    expect(helperSrc).not.toMatch(/item\.status\s*!==\s*['"]resolved['"]/);
  });

  it('helper POSTs to /api/alerts/snooze-batch (the new atomic bulk endpoint)', () => {
    expect(helperSrc).toMatch(/['"]\/api\/alerts\/snooze-batch['"]/);
  });

  it('helper optimistic flip only mutates snoozedUntil (no status flip)', () => {
    // The bulk-snooze path is purely a window stamp — no
    // `status: 'resolved' | 'open' | ...` flip on the optimistic
    // path. (`lastActivityAt` is unrelated; the flip map reads
    // `snoozedUntil` from the envelope.)
    expect(helperSrc).toMatch(/snoozedUntil:\s*newStamp/);
    // Negative: no status-on-flip branch.
    expect(helperSrc).not.toMatch(/item\.status\s*=\s*['"]resolved['"]/);
    expect(helperSrc).not.toMatch(/item\.status\s*=\s*['"]open['"]/);
  });

  it('helper refuses an empty candidate set without firing a fetch', () => {
    expect(helperSrc).toMatch(/candidates\.length\s*===\s*0/);
  });
});
