// @polsia:user-owned — Isolated, allowlisted local TCP scan path for research.
// This module deliberately has no database or web-app imports.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { match } from '@/lib/business/scanner/matcher';
import { detectService } from '@/lib/business/scanner/service-detect';
import { type ProbeResult, probe } from '@/lib/business/scanner/tcp-probe';

export interface LocalTarget {
  host: string;
  port: number;
}

export interface HeuristicCveCandidate {
  cveId: string;
  severity: string | null;
  reason: string;
  source: string;
}

export interface LocalScanResult {
  formatVersion: 1;
  target: string;
  port: number;
  startedAt: string;
  endedAt: string;
  observations: {
    tcpState: ProbeResult['state'];
    latencyMs: number | null;
    bannerReceived: boolean;
    rawBanner: string | null;
    serviceIdentification: {
      serviceHint: string | null;
      banner: string | null;
    };
  };
  heuristicCveCandidates: {
    verified: false;
    description: string;
    items: HeuristicCveCandidate[];
  };
}

export interface RunLocalScanOptions {
  host: string;
  port: number;
  allowlist: readonly LocalTarget[];
  timeoutMs?: number;
  probeTarget?: typeof probe;
}

export function isPrivateOrLoopbackLiteral(host: string): boolean {
  if (host.length === 0 || host !== host.trim() || host.includes('%')) return false;

  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    const [first, second] = octets;
    if (first === undefined || second === undefined) return false;
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (family !== 6) return false;
  const address = ipv6ToBigInt(host);
  if (address === null) return false;
  if (address === 1n) return true;

  // fc00::/7 is IPv6 Unique Local Address space (fc00:: through fdff::).
  return (address >> 121n) === 0b1111110n;
}

export function isLoopbackLiteral(host: string): boolean {
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  return isIP(host) === 6 && ipv6ToBigInt(host) === 1n;
}

export function assertAllowlistedTarget(
  host: string,
  port: number,
  allowlist: readonly LocalTarget[],
): void {
  if (!isPrivateOrLoopbackLiteral(host)) {
    throw new Error(`Target must be a loopback or private literal IP address: ${host}`);
  }
  assertPort(port, 'target port');

  if (!allowlist.some((entry) => entry.host === host && entry.port === port)) {
    throw new Error(`Target pair is not explicitly allowlisted: ${host}:${port}`);
  }
}

export async function loadAllowlist(filePath: string): Promise<LocalTarget[]> {
  const contents = await readFile(filePath, 'utf8');
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Allowlist is not valid JSON: ${filePath}`);
  }

  if (!isRecord(decoded) || !Array.isArray(decoded.targets)) {
    throw new Error('Allowlist must be a JSON object with a targets array.');
  }

  const targets: LocalTarget[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of decoded.targets.entries()) {
    if (
      !isRecord(candidate) ||
      typeof candidate.host !== 'string' ||
      typeof candidate.port !== 'number' ||
      Object.keys(candidate).length !== 2 ||
      !Object.hasOwn(candidate, 'host') ||
      !Object.hasOwn(candidate, 'port')
    ) {
      throw new Error(`Allowlist target at index ${index} must contain only host and port.`);
    }
    if (!isPrivateOrLoopbackLiteral(candidate.host)) {
      throw new Error(`Allowlist target at index ${index} is not a private literal IP.`);
    }
    assertPort(candidate.port, `allowlist port at index ${index}`);

    const key = `${candidate.host}:${candidate.port}`;
    if (seen.has(key)) throw new Error(`Duplicate allowlist target: ${key}`);
    seen.add(key);
    targets.push({ host: candidate.host, port: candidate.port });
  }

  if (targets.length === 0) throw new Error('Allowlist must contain at least one target.');
  return targets;
}

export async function runLocalScan(options: RunLocalScanOptions): Promise<LocalScanResult> {
  // Validate the literal and exact pair before the probe can create a socket.
  assertAllowlistedTarget(options.host, options.port, options.allowlist);

  const startedAt = new Date();
  const probeResult = await (options.probeTarget ?? probe)(
    options.host,
    options.port,
    options.timeoutMs,
  );
  const service = detectService(options.port, probeResult.banner);

  // A null serviceHint keeps this local workflow on the matcher's existing
  // deterministic banner seed table and prevents its optional OSV network path.
  const matches = await match({
    host: options.host,
    port: options.port,
    serviceHint: null,
    banner: probeResult.banner,
  });
  const endedAt = new Date();

  return {
    formatVersion: 1,
    target: options.host,
    port: options.port,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    observations: {
      tcpState: probeResult.state,
      latencyMs: probeResult.latencyMs,
      bannerReceived: probeResult.banner !== null,
      rawBanner: probeResult.banner,
      serviceIdentification: {
        serviceHint: service.serviceHint,
        banner: service.banner,
      },
    },
    heuristicCveCandidates: {
      verified: false,
      description:
        'Unverified banner-based heuristic candidates; these are not confirmed vulnerabilities.',
      items: matches.map((hit) => ({
        cveId: hit.cveId,
        severity: hit.severity,
        reason: hit.matchReason,
        source: hit.source ?? 'banner',
      })),
    },
  };
}

export async function writeScanResult(filePath: string, result: LocalScanResult): Promise<void> {
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function assertPort(port: number, label: string): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ipv6ToBigInt(host: string): bigint | null {
  if (isIP(host) !== 6) return null;

  let address = host.toLowerCase();
  const embeddedIpv4 = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedIpv4?.[1]) {
    const octets = embeddedIpv4[1].split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = address.replace(embeddedIpv4[1], `${high.toString(16)}:${low.toString(16)}`);
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}
