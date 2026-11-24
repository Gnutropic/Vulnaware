// @polsia:user-owned — Multi-select severity filter helpers for the
// /alerts page. The chip row, the page-level parser, the URL writer,
// and both route handlers all share this comma-split/join pipeline so
// a `?severity=critical,high` permalink round-trips byte-for-byte into
// the prisma `where: { severity: { in: [...] } }` shape.
// `Alert.severity` is free-form text on disk, so the parser preserves
// unknown values rather than silently mapping them to a canonical bucket.
// Empty input returns `[]` so an absent key never produces a 400 from the
// route (matches the route's `severity != null && severity !== ''` free-form
// posture). The emitter uses a canonical
// critical → high → medium → low order so a permalink stays
// stable across permutations of chip clicks.

export type SeverityLiteral = string;

export const STANDARD_SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'] as const;

const SEVERITY_RANK = new Map<string, number>(
  STANDARD_SEVERITY_VALUES.map((value, index) => [value, index]),
);

export function parseSeverityFilter(input: string | null | undefined): SeverityLiteral[] {
  if (input == null || input.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of input.split(',')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return sortSeverityValues(out);
}

export function formatSeverityFilter(set: Set<SeverityLiteral> | null | undefined): string | null {
  if (set == null || set.size === 0) return null;
  return sortSeverityValues(set).join(',');
}

/** Sort canonical severities first, then preserve custom values deterministically. */
export function sortSeverityValues(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => {
    const aRank = SEVERITY_RANK.get(a.toLowerCase());
    const bRank = SEVERITY_RANK.get(b.toLowerCase());
    if (aRank != null && bRank != null && aRank !== bRank) return aRank - bRank;
    if (aRank != null && bRank == null) return -1;
    if (aRank == null && bRank != null) return 1;

    const aFolded = a.toLowerCase();
    const bFolded = b.toLowerCase();
    if (aFolded < bFolded) return -1;
    if (aFolded > bFolded) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}
