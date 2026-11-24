// @polsia:user-owned — Pure URL helpers for the /alerts page's bulk-
// resolve working-set ("selection") round-trip. Kept side-effect-free
// so the unit tests can import directly without mocking React or
// next/navigation. The page mirrors the result of `buildSelectedParam`
// into `?selected=` on every state-change; the URL → Set direction is
// `parseSelectedParam`. Both are idempotent: `parseSelectedParam(new
// URLSearchParams({selected: buildSelectedParam(Set{a,b})}))` returns
// Set{a,b} for any well-formed input.
//
// `selected` is intentionally kept OUTSIDE the AlertQuery zod schema
// (mirror of `mine`) — see /api/alerts/export.csv/route.ts for the
// same precedence pattern, applied there so the export contract stays
// decoupled from the UI selection surface.
//
// Round-trip contract enforced by the test assertions:
//   - empty input / empty set  → `buildSelectedParam(...)` is `null`
//     so the page's `effectiveQs` writer can `params.delete('selected')`
//     (a dangling `?selected=` in the URL would silently clear nothing
//     on reload).
//   - duplicates in the URL → the Set's natural cardinality dedupes
//     so a malformed `selected=a,a,b` URL still resolves the right set.
//   - whitespace-only ids → silently dropped (don't double-trim to
//     emit empty members into the round-trip output).

export function parseSelectedParam(sp: URLSearchParams): Set<string> {
  const raw = sp.get('selected') ?? '';
  if (raw.length === 0) return new Set();
  const out = new Set<string>();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

export function buildSelectedParam(ids: Iterable<string>): string | null {
  const list = Array.from(ids, (id) => id.trim()).filter((id) => id.length > 0);
  if (list.length === 0) return null;
  return list.join(',');
}
