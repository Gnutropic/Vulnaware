// @polsia:user-owned — shared zod contract for the scan resource. Imported by
// the /api/scan route handler AND the client island; keep this module client-
// importable (zod only, no server-only imports).

import { z } from 'zod';

// Allowed-ports allowlist for the MVP — bounded set keeps the per-port probe
// time predictable and avoids accidental internet-wide scanning.
const ALLOWED_PORTS = [22, 80, 443, 8080, 8443] as const;
export const PORT_ALLOWLIST = z.union([
  z.literal(22),
  z.literal(80),
  z.literal(443),
  z.literal(8080),
  z.literal(8443),
]);

// Lightweight IPv4 parser. Returns the four octets as numbers, or null when
// the input is not a dotted-quad IPv4 literal.
function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  if (octets.length !== 4) return null;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

// IPv4 reserved ranges that must NEVER be scanned from a PaaS node:
// 0.0.0.0/8          (this network)
// 10.0.0.0/8         (private, RFC 1918)
// 100.64.0.0/10      (CGN)
// 127.0.0.0/8        (loopback)
// 169.254.0.0/16     (link-local)
// 172.16.0.0/12      (private, RFC 1918)
// 192.0.0.0/24       (IETF protocol assignments)
// 192.168.0.0/16     (private, RFC 1918)
// 198.18.0.0/15      (benchmarking)
// 224.0.0.0/4        (multicast)
// 240.0.0.0/4        (reserved)
function isPrivateOrReservedIPv4(o: readonly [number, number, number, number]): boolean {
  const a = o[0];
  const b = o[1];
  const c = o[2];
  if (a === undefined || b === undefined) return false;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // protocol + documentation ranges
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 — documentation
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 — documentation
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 — deprecated relay
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 — multicast
  if (a >= 240) return true; // 240.0.0.0/4 — reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGN
  return false;
}

// Normalize an IPv6 string to its 16-bit hex groups.
function parseIPv6(value: string): number[] | null {
  // Accept bracketed form so an IPv6 host like "[::1]:443" can be parsed when
  // the caller forgets the bracket; bare IPs should pass through untouched.
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);

  // zone-id stripping (fe80::1%eth0)
  const zoneIdx = v.indexOf('%');
  if (zoneIdx !== -1) v = v.slice(0, zoneIdx);

  const groups = v.split('::');
  if (groups.length > 2) return null; // more than one '::' is malformed

  const firstGroup = groups[0] ?? '';
  const secondGroup = groups[1] ?? '';
  const head = firstGroup === '' ? [] : firstGroup.split(':');
  const tail = groups.length === 2 && secondGroup !== '' ? secondGroup.split(':') : [];

  // Validate each head/tail component is a 1-4 digit hex string, allowing IPv4-in-IPv6
  // for the LAST component (e.g. ::ffff:192.168.0.1).
  const parseSegment = (seg: string): number[] => {
    if (seg.includes('.')) {
      const ip = parseIPv4(seg);
      if (!ip) return [];
      // IPv4-mapped: pair of 16-bit words is (high<<8 | low)
      const w1 = ((ip[0] << 8) | ip[1]) >>> 0;
      const w2 = ((ip[2] << 8) | ip[3]) >>> 0;
      return [w1, w2];
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return [];
    return [Number.parseInt(seg, 16)];
  };

  const parsedHead: number[] = [];
  for (const seg of head) {
    const out = parseSegment(seg);
    if (out.length === 0) return null;
    parsedHead.push(...out);
  }
  const parsedTail: number[] = [];
  for (const seg of tail) {
    const out = parseSegment(seg);
    if (out.length === 0) return null;
    parsedTail.push(...out);
  }

  if (groups.length === 1) {
    if (parsedHead.length !== 8) return null;
    return parsedHead;
  }
  // '::' form: head + zeros + tail must equal 8
  if (parsedHead.length + parsedTail.length >= 8) return null;
  const zeros = 8 - parsedHead.length - parsedTail.length;
  return [...parsedHead, ...new Array(zeros).fill(0), ...parsedTail];
}

// IPv6 reserved / non-routable detection:
// ::1                              loopback
// ::                               unspecified
// fe80::/10                        link-local
// fc00::/7                         unique-local (RFC 4193)
// ff00::/8                         multicast
// ::ffff:0:0/96 + private IPv4     IPv4-mapped private
function isPrivateOrReservedIPv6(g: readonly number[]): boolean {
  if (g.length !== 8) return false;
  const w0 = g[0] ?? 0;
  const w1 = g[1] ?? 0;
  const w5 = g[5] ?? 0;
  const w6 = g[6] ?? 0;
  const w7 = g[7] ?? 0;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && w7 === 1) return true; // ::1

  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 — multicast

  // ::ffff:a.b.c.d — IPv4-mapped; decode both embedded IPv4 words.
  if (g.slice(0, 5).every((x) => x === 0) && w5 === 0xffff) {
    const a = (w6 >>> 8) & 0xff;
    const b = w6 & 0xff;
    const c = (w7 >>> 8) & 0xff;
    const d = w7 & 0xff;
    return isPrivateOrReservedIPv4([a, b, c, d]);
  }

  // Only global-unicast IPv6 is an acceptable target. Exclude special-use
  // ranges that sit inside 2000::/3, including documentation and transition
  // prefixes that are not public service destinations.
  if ((w0 & 0xe000) !== 0x2000) return true;
  if (w0 === 0x2001 && (w1 === 0x0000 || w1 === 0x0002 || w1 === 0x0db8)) return true;
  if (w0 === 0x2001 && (w1 & 0xfff0) === 0x0010) return true; // ORCHID
  if (w0 === 0x2002) return true; // 6to4
  return false;
}

// FQDN / hostname validation: per RFC 1123, label is 1-63 chars of [a-zA-Z0-9-]
// not starting or ending with '-'. Total length <= 253.
function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-zA-Z0-9-]+$/.test(label)) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }
  // Reject all-numeric labels which look like IPv4 dotted-quad (the validator
  // already tries parseIPv4 first so this is a defense-in-depth).
  if (labels.every((l) => /^\d+$/.test(l))) return false;
  const reservedSuffixes = new Set([
    'example',
    'internal',
    'invalid',
    'local',
    'localhost',
    'test',
  ]);
  if (reservedSuffixes.has(labels[labels.length - 1]?.toLowerCase() ?? '')) return false;
  return true;
}

/** True only for a numeric IPv4/IPv6 address outside private and special-use ranges. */
export function isPublicRoutableAddress(value: string): boolean {
  const trimmed = value.trim();
  const v4 = parseIPv4(trimmed);
  if (v4) return !isPrivateOrReservedIPv4(v4);
  const v6 = parseIPv6(trimmed);
  return v6 != null && !isPrivateOrReservedIPv6(v6);
}

// target validator — accepts hostnames OR an IP literal, but rejects
// private/loopback/link-local in either.
export const HOSTNAME_OR_IP = z
  .string()
  .min(1, 'Target is required')
  .max(253, 'Target is too long')
  .superRefine((value, ctx) => {
    // Strip surrounding brackets in case the caller typed [::1] etc.
    const trimmed = value.trim();

    // Try IPv4 first.
    const v4 = parseIPv4(trimmed);
    if (v4) {
      if (isPrivateOrReservedIPv4(v4)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Target must be a public, routable address — loopback, private, link-local, multicast and reserved ranges are blocked.',
        });
      }
      return;
    }

    // Try IPv6.
    const v6 = parseIPv6(trimmed);
    if (v6) {
      if (isPrivateOrReservedIPv6(v6)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Target must be a public, routable address — loopback, private, link-local, multicast and reserved ranges are blocked.',
        });
      }
      return;
    }

    // Otherwise the hostname must be a syntactically valid FQDN.
    if (!isValidHostname(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Target must be a public hostname or a public IP literal.',
      });
    }
  });

export const ScanMode = z.literal('tcp-only');

// Marker for the source of a Scan row: who initiated the scan? Used by the
// alerts UI to drive the "Triggered by" filter chip + per-row badge, and by
// the dashboard to bucket scans by origin. Persisted via prisma.scan.create
// `source` column; default is 'scheduled' in the schema (matches the
// backfill rule for pre-existing rows).
export const ScanSourceEnum = z.enum(['ci-webhook', 'scheduled', 'manual']);
export type ScanSource = z.infer<typeof ScanSourceEnum>;

export const ScanCreate = z.object({
  target: HOSTNAME_OR_IP,
  ports: z
    .array(PORT_ALLOWLIST)
    .min(1, 'At least one port is required')
    .max(5, 'At most 5 ports are allowed'),
  mode: ScanMode.default('tcp-only'),
});

export const AssetItem = z.object({
  id: z.string(),
  host: z.string(),
  ip: z.string(),
  port: z.number().int(),
  protocol: z.string(),
  state: z.enum(['up', 'down', 'filtered']),
  latencyMs: z.number().int().nullable(),
  serviceHint: z.string().nullable(),
  banner: z.string().nullable(),
});

export const VulnerabilityFindingItem = z.object({
  id: z.string(),
  assetId: z.string(),
  cveId: z.string(),
  severity: z.string().nullable(),
  matchReason: z.string(),
  priorityScore: z.number().nullable().optional(),
  epssScore: z.number().nullable().optional(),
  epssPercentile: z.number().nullable().optional(),
  kevListed: z.boolean().optional(),
  kevListedAt: z.string().nullable().optional(),
  // Live-intel layer: VulnCheck listing + the rescore audit fields. Additive,
  // so existing clients ignore them; new clients (UI / SIEM) can show the
  // latest bump's source to explain a priority jump.
  vulncheckListed: z.boolean().optional(),
  vulncheckObservedAt: z.string().nullable().optional(),
  lastRescoreAt: z.string().nullable().optional(),
  rescoreSource: z.string().nullable().optional(),
  components: z
    .object({
      cvssContribution: z.number(),
      epssContribution: z.number(),
      kevContribution: z.number(),
      cvssSource: z.enum(['cvss', 'severity', 'missing']).nullable(),
      // VulnCheck boost added when present (else 0). Surfaced in the JSON
      // shape purely so the client tier can render a tooltip — the score
      // is already baked into priorityScore.
      vulncheckContribution: z.number().optional(),
    })
    .optional(),
});

export const ScanItem = z.object({
  id: z.string(),
  target: z.string(),
  mode: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  assets: z.array(AssetItem),
  findings: z.array(VulnerabilityFindingItem),
  kevListedCount: z.number().int().min(0).optional(),
  // Origin marker for the scan. Additive (optional in the wire shape) so an
  // older client that ignores it still parses. Persisted on the row by every
  // scan-write call site (see run-scan RunScanOptions.source).
  source: ScanSourceEnum,
});

export const ScanList = z.object({
  items: z.array(ScanItem),
});

// 400 body shape consumed by applyServerErrors.
export const ScanErrorBody = z.object({
  errors: z.record(z.string(), z.string()),
});

// ===================== REPORT ENDPOINT SCHEMAS =====================
// GET /api/scan/<id>/report — printable remediation report per vulnerability.
// All members are statically typed and round-trip through ReportItem.parse;
// the handler is responsible for sorting cveGroups with the shared comparator
// in src/lib/business/scanner/prioritize.ts so the report and the per-asset
// findings list agree on rank.

export const ReportScanHeader = z.object({
  id: z.string(),
  target: z.string(),
  mode: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  source: ScanSourceEnum,
});

export const ReportMatchedAsset = z.object({
  id: z.string(),
  host: z.string(),
  ip: z.string(),
  port: z.number().int(),
  serviceHint: z.string().nullable(),
  banner: z.string().nullable(),
});

export const ReportCveGroup = z.object({
  cveId: z.string(),
  severity: z.string().nullable(),
  cvssScore: z.number().nullable(),
  epssScore: z.number().nullable(),
  epssPercentile: z.number().nullable(),
  priorityScore: z.number().nullable(),
  kevListed: z.boolean().optional(),
  dateAdded: z.string().nullable().optional(),
  summary: z.string(),
  matchedAssets: z.array(ReportMatchedAsset),
  recommendedFix: z.string(),
  fixVersionOrPatch: z.string().nullable(),
  verificationStep: z.string(),
  references: z.array(z.string()),
});

export const ReportItem = z.object({
  scan: ReportScanHeader,
  cveGroups: z.array(ReportCveGroup),
});

export type ReportScanHeader = z.infer<typeof ReportScanHeader>;
export type ReportMatchedAsset = z.infer<typeof ReportMatchedAsset>;
export type ReportCveGroup = z.infer<typeof ReportCveGroup>;
export type ReportItem = z.infer<typeof ReportItem>;

export type ScanMode = z.infer<typeof ScanMode>;
export type ScanCreate = z.infer<typeof ScanCreate>;
export type ScanCreateInput = z.input<typeof ScanCreate>;
export type AssetItem = z.infer<typeof AssetItem>;
export type VulnerabilityFindingItem = z.infer<typeof VulnerabilityFindingItem>;
export type ScanItem = z.infer<typeof ScanItem>;
export type ScanList = z.infer<typeof ScanList>;
export type ScanErrorBody = z.infer<typeof ScanErrorBody>;

// Re-export the allowlist for the form UI (port picker).
export const ALLOWED_PORT_VALUES = ALLOWED_PORTS;
