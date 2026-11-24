// @polsia:user-owned — Multi-select asset filter helpers for the /alerts
// page. Composite wire identity `${host}:${port}/${protocol}`; the page's
// chip row + URL writer + both route handlers (list + CSV export) all
// route through this single module so a `?asset=example.com:443/tcp`
// permalink round-trips byte-for-byte into the prisma
// `where: { finding: { asset: { OR: [ { host, port, protocol }, ... ] } } }`
// shape.
//
// Wire identity is free-form. Unlike severity (whose enum is sealed
// `critical | high | medium | low`), an asset's composite `${host}
// :${port}/${protocol}` is open-ended — `prisma.asset.host + port +
// protocol` can produce anything, and the /assets rollup already
// treats any per-row ticket as a valid chip. The parser therefore does
// NOT validate against a sealed enum; it splits / trims / dedupes /
// returns the canonical list. The route-side `parseAssetNamesToOrList`
// helper is the single point that DOES validate the host/port/protocol
// shape — bad inputs there throw, the route catches and 400s.
//
// Two helpers are exposed:
//   - `parseAssetFilter` / `formatAssetFilter` — pure list parsing +
//     canonical CSV emitter, mirror of alerts-severity. No protocol-
//     shape validation (the chip row feeds these with names it just
//     read off the server, and the writer emits an identical comma-
//     separated form so the URL is stable across permutations).
//   - `parseAssetNamesToOrList` — single-call helper the route uses
//     to go straight from the raw `?asset=` string to the Prisma
//     `[{ host, port, protocol }, ...]` array. Throws
//     `AssetFilterError` on overflow / malformed name; the route
//     catches it and 400s.
//
// Emitter uses alphabetical canonical order so a permalink stays stable
// across permutations of chip clicks — same shape as the severity
// emitter (`alerts-severity.ts:36-39`).

const ASSET_NAME_REGEX = /^([^:/]+):(\d+)\/([^:/]+)$/;

// Hard cap on the number of asset entries that can ride a single
// `?asset=foo,bar,...` query. Sized to keep the resulting Prisma
// `OR[]` clause under a reasonable IN-list footprint — 50 entries
// still produces a tight composite-index scan on `(host, port)` +
// `@@index([assetId])` on VulnerabilityFinding. Posts above this cap
// are 400'd by the route so a malicious URL can't drive an
// unbounded IN-list.
export const MAX_ASSET_FILTER_ENTRIES = 50;

// Single shape for both error modes the route maps to 400. The route
// catches `AssetFilterError` and stamps the `message` straight onto
// the JSON response body so a bad URL is readable on the operator's
// toast (parity with the AlertQuery 400 body).
export class AssetFilterError extends Error {
  readonly code: 'too_many_entries' | 'malformed_name';
  constructor(code: 'too_many_entries' | 'malformed_name', message: string) {
    super(message);
    this.code = code;
    this.name = 'AssetFilterError';
  }
}

// Pure list parser. Returns the canonical-name list (sorted A→Z,
// deduped, blanks dropped). Used by the page-level
// `parseFiltersFromParams` to hydrate the chip row's `Set<string>`
// from the URL on first mount. Empty / null / blank input returns
// `[]` so a malformed key silently strips instead of narrowing the
// resultset to zero (parity with `parseSeverityFilter`).
export function parseAssetFilter(input: string | null | undefined): string[] {
  if (input == null || input.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of input.split(',')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  // Alphabetical canonical so two equal sets produce the same CSV;
  // the emitter would do this anyway but it's cheaper to do it once.
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// Canonical-CSV emitter. Returns null when the Set is empty / null so
// the page's `buildEffectiveQs` writer can drop the `?asset=` key
// cleanly.
export function formatAssetFilter(set: Set<string> | null | undefined): string | null {
  if (set == null || set.size === 0) return null;
  return Array.from(set)
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

// Per-name parser. Splits a composite `${host}:${port}/${protocol}`
// into the schema keyed triplet, OR returns null for a name that
// doesn't match the shape. The list-level helper
// `parseAssetNamesToOrList` calls this for each entry and converts
// nulls into `AssetFilterError('malformed_name', ...)`.
export function parseAssetName(
  name: string,
): { host: string; port: number; protocol: string } | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const m = ASSET_NAME_REGEX.exec(name);
  if (m == null) return null;
  // `noUncheckedIndexedAccess` widens capture-group reads to
  // `string | undefined` even when the regex has anchors that
  // guarantee the length. Narrow with explicit checks so the typed
  // output stays `string` (no defensive `?? default` masks bugs).
  const host = m[1];
  const portStr = m[2];
  const protocol = m[3];
  if (host === undefined || portStr === undefined || protocol === undefined) return null;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port, protocol };
}

// Single-call helper that takes the raw `?asset=` string the route
// reads off the URL and returns the array of `{ host, port, protocol }`
// triplets the Prisma `where: { finding: { asset: { OR: [...] } } }`
// clause expects. Empty / null input returns `[]` so an absent key
// drops the clause cleanly. Throws `AssetFilterError` on either of:
//   - `too_many_entries` (> MAX_ASSET_FILTER_ENTRIES) — bounds the
//     IN-list footprint;
//   - `malformed_name` — a name that doesn't match the composite
//     shape regex. The route catches and stamps a 400.
export function parseAssetNamesToOrList(
  input: string | null | undefined,
): Array<{ host: string; port: number; protocol: string }> {
  const names = parseAssetFilter(input);
  if (names.length === 0) return [];
  if (names.length > MAX_ASSET_FILTER_ENTRIES) {
    throw new AssetFilterError(
      'too_many_entries',
      `?asset= accepts at most ${MAX_ASSET_FILTER_ENTRIES} entries (got ${names.length}).`,
    );
  }
  const out: Array<{ host: string; port: number; protocol: string }> = [];
  for (const name of names) {
    const parsed = parseAssetName(name);
    if (parsed == null) {
      throw new AssetFilterError(
        'malformed_name',
        `?asset= entry "${name}" is not in host:port/protocol shape.`,
      );
    }
    out.push(parsed);
  }
  return out;
}
