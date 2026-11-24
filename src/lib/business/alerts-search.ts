// @polsia:user-owned — Shared search/lookup plumbing for the /alerts
// surface.
//
// The free-form `q=` narrows across three OR arms that map the
// brief's high-level arms onto today's implementation:
//
//   brief's "CVE id" arm (case-insensitive substring)  →  today's arm #1:
//     `finding.cveId contains q, mode: 'insensitive'`. The case-fold
//     rides Prisma's `mode: 'insensitive'` — no `toUpperCase()` on the
//     hot path. Substring (NOT exact) so typing `CVE-2024-` matches any
//     cveId starting with that prefix; the operator can match a canonical
//     CVE like `CVE-2021-44228` with a non-canonical typed query like
//     `cve-2021-44228` (and vice versa) without forking the URL contract.
//     The cveId B-tree index covers prefix-leaning queries (e.g.
//     `?q=CVE-2024-`); a pathological MID-string substring like
//     `?q=-44228` falls back to a sequential scan — do not widen other
//     arms without evaluating index coverage first.
//
//   brief's "join on Asset.hostname" arm  →  today's arm #2:
//     `finding.asset.host contains q, mode: 'insensitive'`. The
//     brief's `hostname` is the existing `Asset.host` column (no
//     schema rename / migration needed). No pre-query required:
//     unlike the description arm, this join is expressible as a
//     single nested Prisma `where` clause, and the `@@index([host,
//     port])` on `Asset` covers it without an extra DB round trip.
//
//   brief's "ILIKE on findingTitle" arm  →  today's arm #3:
//     `finding.cveId in [cveIds matching CveEntry.description contains
//     q, mode: 'insensitive']`. The brief's `findingTitle` is
//     operationally `AlertItem.vulnerabilityTitle` — surfaced from
//     `CveEntry.description` via the route's batched
//     `batchFetchAlertVulnerabilityTitles` peer-read. Because
//     `VulnerabilityFinding` has no Prisma relation to `CveEntry` in
//     the schema (a locked decision that avoids a schema shift +
//     migration), the join happens in app code: a pre-query on
//     `CveEntry.description contains q` returns a cveId set, which is
//     folded into a `finding.cveId in [...]` Prisma arm. Operationally
//     identical to a direct ILIKE on a hypothetical finding-side
//     title column — a case-insensitive substring match against the
//     joined CVE description. Empty result drops the arm so an
//     unparseable query still narrows on the cveId substring side.
//
// `buildAlertSearchWhere(q, hostname)` returns the full `finding:` literal
// in one call. The hostname arm is an AND sibling of q's OR arm, so adding
// a hostname cannot broaden the existing text-search result set. Empty
// inputs short-circuit to `{}` so a deep-spread into the route's `where`
// keeps the existing shallow-spread structure static.
//
// `batchFetchAlertVulnerabilityTitles(cveIds)` is a batched peer-read
// that maps the page's distinct cveIds to a `Map<string, string | null>`.
// The route stamps that onto each mapped `AlertItem.vulnerabilityTitle`.
// CveEntry miss → null so the wire contract's
// `vulnerabilityTitle: z.string().nullable()` keeps a clean null branch.
//
// Both /api/alerts GET AND /api/alerts/export.csv call the same helpers
// so the CSV honors `q=` automatically — diverging them would silently
// drop the search when an operator exports a filtered table.

import 'server-only';
import { prisma } from '@/lib/db';

// Build the `finding:` literal Prisma where clause for the `q=` filter.
// Returns `{}` when `q` is empty so a deep-spread into the route's wider
// `where` shape keeps the existing shallow-spread footgun static (see
// route.ts:131-144, which already composes `triggeredBy` + this clause
// into one literal to avoid a second spread overwriting the first).
export async function buildAlertSearchWhere(
  q: string | undefined,
  hostname?: string,
): Promise<Record<string, unknown>> {
  const hostnameQuery = hostname?.trim();
  if (!q && !hostnameQuery) return {};

  const hostnameClause = hostnameQuery
    ? { host: { contains: hostnameQuery, mode: 'insensitive' as const } }
    : undefined;

  if (!q) {
    return hostnameClause ? { finding: { asset: hostnameClause } } : {};
  }

  // Description arm: resolve via CveEntry directly. CveEntry has no
  // Prisma relation to VulnerabilityFinding today, so the join has to
  // happen here in app code; the resulting cve id list is folded into
  // the `finding.cveId in [...]` Prisma OR arm. Empty result drops the
  // arm so an unparseable / unmatched query still narrows on the
  // cveId substring side. q is preserved verbatim on the cveId arm —
  // no `toUpperCase()` happens at request time. The case-fold rides
  // Prisma's `mode: 'insensitive'` on `contains` so the operator can
  // type `CVE-2024-` and match every cveId starting with that prefix,
  // PLUS still match a canonical CVE like `CVE-2021-44228` with a
  // non-canonical typed query like `cve-2021-44228` (and vice versa)
  // without forking the URL contract.
  const cveIdsByDescription = await matchCveIdsByDescription(q);

  const orArms: Array<Record<string, unknown>> = [
    { cveId: { contains: q, mode: 'insensitive' as const } },
    { asset: { host: { contains: q, mode: 'insensitive' as const } } },
  ];
  if (cveIdsByDescription.length > 0) {
    orArms.push({ cveId: { in: cveIdsByDescription } });
  }

  return {
    finding: {
      OR: orArms,
      ...(hostnameClause ? { asset: hostnameClause } : {}),
    },
  };
}

async function matchCveIdsByDescription(q: string): Promise<string[]> {
  if (!q) return [];
  const matches = await prisma.cveEntry.findMany({
    where: { description: { contains: q, mode: 'insensitive' } },
    select: { cveId: true },
  });
  return Array.from(new Set(matches.map((m) => m.cveId)));
}

// Batched peer-read for the `vulnerabilityTitle` stamp. Distinct cveIds
// only — dedup'ing here keeps the CveEntry round trip bounded by
// distinct ids rather than by N rows on the page. Returns `null` per id
// when the CVE has no CveEntry row yet (cold-start / pre-ingest) so the
// wire contract's `vulnerabilityTitle: z.string().nullable()` keeps a
// clean null branch without an extra parse-time falsy check.
export async function batchFetchAlertVulnerabilityTitles(
  cveIds: readonly string[],
): Promise<Map<string, string | null>> {
  const distinct = Array.from(
    new Set(cveIds.filter((v): v is string => typeof v === 'string' && v.length > 0)),
  );
  if (distinct.length === 0) return new Map();

  const entries = await prisma.cveEntry.findMany({
    where: { cveId: { in: distinct } },
    select: { cveId: true, description: true },
  });
  const map = new Map<string, string | null>();
  for (const id of distinct) map.set(id, null);
  for (const e of entries) map.set(e.cveId, e.description ?? null);
  return map;
}
