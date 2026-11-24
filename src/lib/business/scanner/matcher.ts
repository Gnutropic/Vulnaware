// @polsia:user-owned — Maps a probed + classified asset to a list of CVEs.
// Two sources in priority order:
//
//   1. A small HARDCODED seed table of well-known (service, versionRange) →
//      CVE mappings (Heartbleed, Shellshock-era nginx, vsftpd backdoor, …).
//      The seed is a deliberate constant — relying on remote OSV in unit
//      tests would mean either mocking the global fetch or burning NVD Pro
//      quota in CI; both worse than a constant.
//
//   2. (reserved) An OSV.dev round-trip when we have a real version +
//      package from a banner. Wired but not exercised by default — the MVP
//      surfaces seed findings only.

import { type OsvHit, queryOsv } from '@/lib/business/scanner/cve-feed';

export type CloudDiscoveryProvider = 'aws' | 'azure' | 'gcp';

export interface MatcherInput {
  host: string;
  port: number;
  serviceHint: string | null;
  banner: string | null;
}

export interface MatcherHit {
  cveId: string;
  severity: string | null;
  matchReason: string;
  // Provenance flag — 'banner' for the host:port SEED table (default for
  // match()), 'cve-db' for entries that resolve to a real CVE id surfaced
  // from cve-feed.ts, or 'shape' for synthesized entries that point at a
  // real CVE descriptor (used by RESOURCE_SEED when the seed entry has
  // an alias cveId but the underlying real CVE id is stored separately).
  source?: 'banner' | 'cve-db' | 'shape';
}

export interface MatcherContext {
  queryOsv: (packageName: string, version: string) => Promise<OsvHit[]>;
}

/**
 * Create a lookup cache for one scan. Different asset checks can resolve to
 * the same package/version metadata; share the in-flight and completed OSV
 * read without sharing state across scans or teams.
 */
export function createMatcherContext(): MatcherContext {
  const osvByPackageVersion = new Map<string, Promise<OsvHit[]>>();

  return {
    queryOsv(packageName, version) {
      const key = JSON.stringify([packageName, version]);
      const cached = osvByPackageVersion.get(key);
      if (cached) return cached;

      const pending = queryOsv(packageName, version);
      osvByPackageVersion.set(key, pending);
      return pending;
    },
  };
}

export interface ResourceMatcherInput {
  provider: CloudDiscoveryProvider;
  resourceType: string;
  publicExposure: 'public' | 'private' | 'unknown';
  serviceHint: string | null;
}

// Hardcoded seed table — `(service, versionPredicate) → list of CVEs`.
// Each entry has a stable rationale so the UI can render *why* the CVE fired
// without forcing the operator to consult external docs.
interface SeedEntry {
  service: string;
  predicate: (banner: string | null) => boolean;
  cveId: string;
  severity: string;
  matchReason: string;
}

const SEED: readonly SeedEntry[] = [
  {
    service: 'openssl',
    predicate: (b) => /OpenSSL\/1\.0\.1(?:\.\d+)?(?:[a-z]?)?/i.test(b ?? ''),
    cveId: 'CVE-2014-0160',
    severity: 'High',
    matchReason:
      'OpenSSL 1.0.1 banner — vulnerable to Heartbleed (memory disclosure via malformed TLS heartbeat).',
  },
  {
    service: 'openssl',
    predicate: (b) => /OpenSSL\/1\.0\.2[a-z]?/i.test(b ?? ''),
    cveId: 'CVE-2016-2107',
    severity: 'High',
    matchReason: 'OpenSSL 1.0.2 — ASN.1 padding oracle in AES-NI CBC cipher suites.',
  },
  {
    service: 'openssl',
    predicate: (b) => /OpenSSL\/1\.1\.1[a-z]?/i.test(b ?? ''),
    cveId: 'CVE-2023-0464',
    severity: 'Medium',
    matchReason:
      'OpenSSL 1.1.1 — leaf-node chain validation bypass under specific X.509 verifier policies.',
  },
  {
    service: 'openssh',
    predicate: (b) => /SSH-2\.0-OpenSSH_[5-7]\./.test(b ?? ''),
    cveId: 'CVE-2016-0777',
    severity: 'Medium',
    matchReason:
      'OpenSSH 5.x–7.x — roamable client private-key disclosure (only if UseRoaming=no is unset).',
  },
  {
    service: 'openssh',
    predicate: (b) => /SSH-2\.0-OpenSSH_8\.(0|1|2|3|4)p?1/.test(b ?? ''),
    cveId: 'CVE-2023-38408',
    severity: 'High',
    matchReason:
      'OpenSSH 8.0p1–8.4p1 — ssh-agent PKCS#11 forwarding RCE under specific agent configurations.',
  },
  {
    service: 'nginx',
    predicate: (b) => /nginx\/0\.(?:6|7)\./.test(b ?? ''),
    cveId: 'CVE-2009-3898',
    severity: 'Medium',
    matchReason: 'nginx 0.6.x/0.7.x — heap underflow in ngx_http_parse_complex_value.',
  },
  {
    service: 'apache',
    predicate: (b) => /Apache\/2\.2\.(0|1|2|3|4|5|6|7|8|9|1[0-7])/.test(b ?? ''),
    cveId: 'CVE-2017-15715',
    severity: 'Medium',
    matchReason:
      'Apache httpd 2.2.x — newline-in-Filename bypass of `<FilesMatch>` access control.',
  },
  {
    service: 'vsftpd',
    predicate: (b) => /vsftpd\s*2\.3\.4/.test(b ?? ''),
    cveId: 'CVE-2011-2523',
    severity: 'Critical',
    matchReason: 'vsftpd 2.3.4 — backdoored build opens an unauthenticated root shell on TCP/6200.',
  },
];

// Best-effort version extraction. Returns null when the banner has no
// recognizable service/version syntax; matcher.readBannerMatch falls back
// to the seed predicates which already encode their own patterns.
function extractVersion(banner: string | null): string | null {
  if (!banner) return null;
  const patterns: ReadonlyArray<RegExp> = [
    /SSH-2\.0-OpenSSH_(\d+(?:\.\d+)+(?:p\d+)?)/,
    /nginx\/([\d.]+)/i,
    /Apache\/([\d.]+)/i,
    /OpenSSL\/([\d.]+[a-z]?)/i,
    /vsftpd\s*([\d.]+)/i,
  ];
  for (const pattern of patterns) {
    const match = banner.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function bannerFlagsService(banner: string | null, service: string): boolean {
  if (!banner) return false;
  switch (service) {
    case 'openssl':
      return /OpenSSL/i.test(banner);
    case 'openssh':
      return /OpenSSH/i.test(banner);
    case 'nginx':
      return /nginx/i.test(banner);
    case 'apache':
      return /Apache|httpd/i.test(banner);
    case 'vsftpd':
      return /vsftpd/i.test(banner);
    default:
      return false;
  }
}

export async function match(
  input: MatcherInput,
  context: MatcherContext = createMatcherContext(),
): Promise<MatcherHit[]> {
  const hits: MatcherHit[] = [];
  for (const entry of SEED) {
    if (!bannerFlagsService(input.banner, entry.service)) continue;
    if (!entry.predicate(input.banner)) continue;
    hits.push({
      cveId: entry.cveId,
      severity: entry.severity,
      matchReason: entry.matchReason,
    });
  }

  // Reserved OSV path. We only consult OSV when a banner names a package +
  // version (rare, but the seed above misses real coverage). Kept guarded
  // by an explicit comment so a future agent knows the seam exists.
  const version = extractVersion(input.banner);
  if (version && hits.length === 0 && input.serviceHint) {
    try {
      const pkg = guessPackage(input.serviceHint);
      if (pkg) {
        const osv = await context.queryOsv(pkg, version);
        for (const v of osv) {
          hits.push({
            cveId: v.id,
            severity: v.severity,
            matchReason: `OSV.dev match for ${pkg}@${version} — ${v.summary ?? 'no summary provided.'}`,
          });
        }
      }
    } catch {
      // OSV is best-effort; swallow failures so the seed path still surfaces.
    }
  }

  return hits;
}

function guessPackage(serviceHint: string): string | null {
  switch (serviceHint) {
    case 'ssh':
      return 'openssh';
    case 'nginx':
      return 'nginx';
    case 'apache':
      return 'httpd';
    default:
      return null;
  }
}

interface ResourceSeedEntry {
  provider: CloudDiscoveryProvider;
  resourceType: string;
  predicate: (input: ResourceMatcherInput) => boolean;
  cveId: string;
  severity: string;
  matchReason: string;
}

// RESOURCE_SEED — resource-shape fingerprints. Each entry is keyed by
// (provider, resourceType) with a predicate over the public-exposure +
// serviceHint signals. Hits are tagged `source: 'shape'` so the orchestrator
// stamps cveSource='shape' on the resulting AwsFinding/AzureFinding/GcpFinding
// rows. Some entries refer to real CVE ids (from cve-feed.ts); we encode
// the real id in the cveId column so a single enum-shaped cveId string is
// the wire shape. The 'shape' flag PLUS the cveId lets a future browser
// distinguish "synthesized AWS-VPC-EGRESS-001 alias of CVE-202X-XXXXX"
// from "actual CVE-2014-0160 fired by matcher.ts on a banner".
const RESOURCE_SEED: readonly ResourceSeedEntry[] = [
  // AWS resource-shape fingerprints.
  {
    provider: 'aws',
    resourceType: 'aws:rds:db',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'AWS-RDS-PUBLIC-001',
    severity: 'High',
    matchReason:
      'RDS DB instance publicly accessible (`PubliclyAccessible=true`). Move behind a private subnet + IAM authentication; deny all public network access unless explicitly required.',
  },
  {
    provider: 'aws',
    resourceType: 'aws:dynamodb:table',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'AWS-DDB-PUBLIC-001',
    severity: 'High',
    matchReason:
      'DynamoDB table with public resource policy. Restrict `Principal` to specific accounts/roles; consider VPC endpoint policies.',
  },
  {
    provider: 'aws',
    resourceType: 'aws:ec2:securitygroup',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'AWS-SG-OPEN-001',
    severity: 'Medium',
    matchReason:
      'Security group opens 0.0.0.0/0 on at least one inbound rule. Audit the rule list and lock down to specific CIDRs.',
  },
  // Azure resource-shape fingerprints.
  {
    provider: 'azure',
    resourceType: 'microsoft.sql/servers',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'AZ-SQL-PUBLIC-001',
    severity: 'High',
    matchReason:
      'Azure SQL server has `publicNetworkAccess=Enabled`. Disable public network access and enforce private endpoints.',
  },
  {
    provider: 'azure',
    resourceType: 'microsoft.sql/servers/databases',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'AZ-SQLDB-PUBLIC-001',
    severity: 'High',
    matchReason:
      'Azure SQL database inherits a public-network server. Disable public network access on the parent server.',
  },
  {
    provider: 'azure',
    resourceType: 'microsoft.network/networksecuritygroups',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'AZ-NSG-OPEN-001',
    severity: 'Medium',
    matchReason:
      'NSG opens inbound to `0.0.0.0/0` / `*` / `Internet` on Allow. Tighten source address prefixes.',
  },
  // GCP resource-shape fingerprints.
  {
    provider: 'gcp',
    resourceType: 'sqladmin.googleapis.com/Instance',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'GCP-SQL-PUBLIC-001',
    severity: 'High',
    matchReason:
      'Cloud SQL instance has a public IP enabled. Configure private IP + Cloud SQL Auth Proxy instead.',
  },
  {
    provider: 'gcp',
    resourceType: 'compute.googleapis.com/Firewall',
    predicate: (input) => input.publicExposure === 'public',
    cveId: 'GCP-FW-OPEN-001',
    severity: 'Medium',
    matchReason:
      'GCP firewall rule ingress opens to 0.0.0.0/0 or ::/0. Narrow the source range to specific IPs or VPC ranges.',
  },
];

/**
 * Cross provider + resourceType against the resource-shape fingerprint
 * seed table. Hits carry `source: 'shape'` so the orchestrator's finding-
 * write code can stamp cveSource='"shape"' on the resulting
 * Aws*Finding/Azure*Finding/Gcp*Finding row. The host:port-labeled 'banner'
 * and the cve-feed-labeled 'cve-db' sources are reserved for the existing
 * matcher.match() return path + future banner-driven host:port retries.
 */
export async function matchResource(input: ResourceMatcherInput): Promise<MatcherHit[]> {
  const hits: MatcherHit[] = [];
  for (const entry of RESOURCE_SEED) {
    if (entry.provider !== input.provider) continue;
    if (entry.resourceType !== input.resourceType) continue;
    if (!entry.predicate(input)) continue;
    hits.push({
      cveId: entry.cveId,
      severity: entry.severity,
      matchReason: entry.matchReason,
      source: 'shape',
    });
  }
  return hits;
}
