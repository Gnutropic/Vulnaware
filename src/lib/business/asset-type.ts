// @polsia:user-owned — Pure helper that maps an `Asset` row's
// `(serviceHint, port)` pair to a stable, enumerable asset-type literal.
// Powers:
//   - /api/assets JSON rollup (per-host row's `assetType` column).
//   - /api/assets/export.csv row's `assetType` cell.
//   - `<AssetsTable>`'s asset-type cell rendering.
//
// No Prisma, no `server-only` — the helper stays pure so it can be
// imported from the contract module's zod enum, the JSON route, the CSV
// route, and the client island without an extra boundary. The host
// reducer feeds it each contributing row's `serviceHint + port` and
// reconciles via `pickDominantAssetType` (exported below) so a single
// host that listened on multiple ports/services surfaces the
// highest-tier category.
//
// Tier ranks (higher wins): database > mail > ssh > api > web > unknown.
// "Highest-tier" reflects operator triage: the most-sensitive service
// the scanner actually observed on the host. Database-and-mail tier
// before web-tier so an operator triaging a row can see "this host was
// found running a database" before "this host also spoke HTTP".
//
// serviceHint alias normalization is intentionally permissive — any
// `serviceHint` string we can plausibly map is mapped; everything else
// falls through to the port-class buckets below. If both arms fail
// the literal collapses to `'unknown'` so the route never stamps
// `null` on the wire (and the zod refinement doesn't have to widen to
// nullable).

export type AssetTypeLiteral = 'web' | 'ssh' | 'database' | 'mail' | 'api' | 'unknown';

// Higher number = higher priority. The reducer in /api/assets and
// /api/assets/export.csv walks every contributing row for a host and
// keeps the candidate whose rank is strictly greater than the running
// max. Public so the reducer code reads the table verbatim instead of
// hard-coding a rank ladder of its own.
export const ASSET_TYPE_RANK: Record<AssetTypeLiteral, number> = {
  web: 1,
  api: 2,
  ssh: 3,
  mail: 4,
  database: 5,
  unknown: 0,
};

const SERVICE_HINT_HINTS: ReadonlyArray<readonly [RegExp, AssetTypeLiteral]> = [
  // Database — Postgres, MySQL, MariaDB, Mongo, Redis, MSSQL, Cassandra/
  // Scylla (CQL), Elasticsearch, Oracle, Cockroach. Aliased by both
  // the canonical name and common abbreviations.
  [
    /(postgres|postgresql|mysql|mariadb|mongo|redis|mssql|cockroach|cassandra|scylla|elastic|elasticsearch|oracle|sqlserver)/i,
    'database',
  ],
  // Mail — SMTP / IMAP / POP3 / submission / SMTPS / submission-over-
  // TLS, plus the common daemons (Postfix, Dovecot, Sendmail, Exim,
  // Exchange). Matches on substring so "postfix smtpd" or
  // "Microsoft Exchange" both land here.
  [/(smtp|smtps|imap|imaps|pop3|pop3s|submission|postfix|dovecot|sendmail|exim|exchange)/i, 'mail'],
  // SSH — OpenSSH is the dominant banner; include dropssh-style
  // variants. Match on substring.
  [/(openssh|dropbear|ssh)/i, 'ssh'],
  // API — explicit "api" or framework hints that mark a JSON/RPC
  // service. Substring to match "fastapi", "go-api", etc.
  [/(api|graphql|grpc)/i, 'api'],
  // Web — explicit protocol banners ("HTTP", "HTTPS") plus the common
  // daemon banners (nginx, Apache httpd, IIS, Tomcat, Caddy,
  // lighttpd, Jetty, gunicorn). Last so a banner that says
  // "Microsoft Exchange HTTP" hits the mail tier above first.
  [/(nginx|apache|httpd|iis|tomcat|caddy|lighttpd|jetty|gunicorn|https?\/)/i, 'web'],
];

const PORT_HINTS: ReadonlyArray<readonly [number[], AssetTypeLiteral]> = [
  // SSH
  [[22], 'ssh'],
  // Mail — SMTP (25), submission (587), SMTPS (465), POP3 (110),
  // POP3S (995), IMAP (143), IMAPS (993). RFC 6335 port list for
  // mail-bearing protocols.
  [[25, 110, 143, 465, 587, 993, 995], 'mail'],
  // Database — MySQL/MariaDB (3306), Postgres (5432), MSSQL (1433),
  // Mongo (27017), Redis (6379), Cassandra inter-node (9042),
  // Elasticsearch (9200), CouchDB (5984), Oracle (1521), SAP HANA
  // (50000). Conservative set — covers the noisy ones a scanner
  // confirms in the wild.
  [[3306, 5432, 1433, 27017, 6379, 9042, 9200, 5984, 1521, 50000], 'database'],
  // API — developer-friendly ports the scanner commonly stamps for
  // "looks like an internal API service". 3000/4000/5000/8000/8080/
  // 8443 cover the long tail; we put web-tier higher because HTTP
  // servers typically win on banner, and these tiers reconcile on
  // service-hint when both arms fire.
  [[3000, 4000, 5000, 8000, 8080, 8443, 8888, 9000], 'api'],
  // Web — HTTP/S plus the alternate dev-server ports (8000/8080/8443
  // overlap with `api`; whichever tier the hint+port ladder lands
  // on wins via `pickDominantAssetType`).
  [[80, 443, 8000, 8080, 8443], 'web'],
];

function matchServiceHint(hint: string | null | undefined): AssetTypeLiteral | null {
  if (typeof hint !== 'string') return null;
  const trimmed = hint.trim();
  if (trimmed.length === 0) return null;
  for (const [pattern, literal] of SERVICE_HINT_HINTS) {
    if (pattern.test(trimmed)) return literal;
  }
  return null;
}

function matchPort(port: number | null | undefined): AssetTypeLiteral | null {
  if (port == null || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  for (const [range, literal] of PORT_HINTS) {
    if (range.includes(port)) return literal;
  }
  return null;
}

// Single-row mapping. Always returns one of the enumerable literals —
// never null — so the wire shape is non-nullable and the zod
// refinement stays a sealed enum. The reduce in /api/assets reads
// `serviceHint` from the joined Asset row and `port` from the
// contributing alert's finding's asset; both are nullable, both fall
// through to `'unknown'` if absent rather than stamping null on the
// wire.
export function inferAssetType(input: {
  serviceHint: string | null | undefined;
  port: number | null | undefined;
}): AssetTypeLiteral {
  return matchServiceHint(input.serviceHint) ?? matchPort(input.port) ?? 'unknown';
}

// Reconcile two candidates for the same host: keep the higher-tier
// one. The reducer feeds each contributing row's call result through
// this so a single host that spans database + web ports surfaces as
// `database`. `prior === null` short-circuits to the candidate so the
// starter state on the first row is just `candidate`.
export function pickDominantAssetType(
  prior: AssetTypeLiteral | null,
  candidate: AssetTypeLiteral,
): AssetTypeLiteral {
  if (prior == null) return candidate;
  return ASSET_TYPE_RANK[candidate] > ASSET_TYPE_RANK[prior] ? candidate : prior;
}
