// @polsia:user-owned — Self-serve trial workspace sample-seed.
//
// Pre-populates a freshly-provisioned trial workspace with a deterministic
// asset inventory + CVE dataset so the trialist lands at /trial/started and
// sees a populated dashboard rather than an empty state. Idempotent — keyed
// on the (teamId, targetHost) Scan row, so a re-run on the same team is a
// no-op via upsert.
//
// Deliberately does NOT hit the NVD/KEV/EPSS/VulnCheck feeds (those would
// slow provisioning and may fail at the moment of signup; we want the
// trialist in the dashboard immediately). Scores are baked from the seed
// table so the dashboard renders the same baseline every time.

import 'server-only';
import { brand } from '@/lib/brand';
import { seedBlogSample } from '@/lib/business/blog-seed';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

interface SampleAsset {
  port: number;
  protocol: string;
  serviceHint: string;
  state: string;
  latencyMs: number;
  banner: string;
}

const SAMPLE_HOST = '203.0.113.10'; // RFC 5737 TEST-NET-3 — non-routable, safe to ship
const SAMPLE_IPS: Record<number, string> = {
  22: '203.0.113.10',
  80: '203.0.113.10',
  443: '203.0.113.10',
};

const SAMPLE_ASSETS: SampleAsset[] = [
  {
    port: 443,
    protocol: 'tcp',
    serviceHint: 'https',
    state: 'open',
    latencyMs: 18,
    banner: 'HTTP/1.1 200 OK\r\nServer: nginx/1.22.1\r\nContent-Type: text/html; charset=utf-8',
  },
  {
    port: 80,
    protocol: 'tcp',
    serviceHint: 'http',
    state: 'open',
    latencyMs: 14,
    banner: 'HTTP/1.1 301 Moved Permanently\r\nServer: nginx/1.22.1\r\nLocation: https:///',
  },
  {
    port: 22,
    protocol: 'tcp',
    serviceHint: 'ssh',
    state: 'open',
    latencyMs: 22,
    banner: 'SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6',
  },
];

// Deterministic CVE/match-reason baseline. Five web-tier + one SSH finding —
// mix of critical/high, with KEV and VulnCheck toggled so the dashboard
// demonstrates every severity band on first paint. EPSS is mixed (low,
// medium, high) so priority score is varied.
interface SampleCve {
  cveId: string;
  cvssScore: number;
  severity: string;
  epss: number;
  epssPercentile: number;
  kevListed: boolean;
  vulncheckListed: boolean;
  matchReason: string;
  assetPort: number;
}

const SAMPLE_CVES: SampleCve[] = [
  {
    cveId: 'CVE-2024-3094',
    cvssScore: 10.0,
    severity: 'critical',
    epss: 0.93,
    epssPercentile: 0.99,
    kevListed: true,
    vulncheckListed: true,
    matchReason: 'OpenSSH 8.9p1 detected — known backdoor in xz/liblzma dependency chain.',
    assetPort: 22,
  },
  {
    cveId: 'CVE-2023-44487',
    cvssScore: 7.5,
    severity: 'high',
    epss: 0.71,
    epssPercentile: 0.95,
    kevListed: true,
    vulncheckListed: true,
    matchReason: 'nginx 1.22.1 — HTTP/2 rapid-reset DoS.',
    assetPort: 443,
  },
  {
    cveId: 'CVE-2024-6387',
    cvssScore: 8.1,
    severity: 'high',
    epss: 0.62,
    epssPercentile: 0.92,
    kevListed: false,
    vulncheckListed: true,
    matchReason: 'OpenSSH 8.9p1 — regreSSHion race condition in SIGALRM handler.',
    assetPort: 22,
  },
  {
    cveId: 'CVE-2024-7341',
    cvssScore: 9.8,
    severity: 'critical',
    epss: 0.84,
    epssPercentile: 0.97,
    kevListed: false,
    vulncheckListed: true,
    matchReason: 'nginx ngx_http_headers_module — directory-traversal via crafted Range.',
    assetPort: 443,
  },
  {
    cveId: 'CVE-2024-21626',
    cvssScore: 8.6,
    severity: 'high',
    epss: 0.42,
    epssPercentile: 0.78,
    kevListed: false,
    vulncheckListed: false,
    matchReason: 'OpenSSH 8.9p1 — netstack file descriptor leak via PROCESS_FD.',
    assetPort: 22,
  },
  {
    cveId: 'CVE-2024-0078',
    cvssScore: 7.2,
    severity: 'high',
    epss: 0.18,
    epssPercentile: 0.6,
    kevListed: false,
    vulncheckListed: false,
    matchReason: 'OpenSSL on nginx — SELECT into same SSLeay context race.',
    assetPort: 443,
  },
];

// Local mirror of the shared priority formula so we don't drag client/
// server-only code into a Server Component's path. Mirrors
// src/lib/business/scanner/prioritize.ts.
const CVSS_WEIGHT = 0.6;
const EPSS_WEIGHT = 0.4;
const KEV_WEIGHT = 2.0;
const VULNCHECK_WEIGHT = 2.6;
const VULNCHECK_EPSS_FLOOR = 0.05;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function computePriority(c: SampleCve): number {
  const cvss = clamp(c.cvssScore, 0, 10);
  const epss = clamp(c.epss, 0, 1);
  const kevOn = c.kevListed;
  const vcOn = c.vulncheckListed && epss >= VULNCHECK_EPSS_FLOOR;
  return clamp(
    CVSS_WEIGHT * cvss +
      EPSS_WEIGHT * epss +
      (kevOn ? KEV_WEIGHT : 0) +
      (vcOn ? VULNCHECK_WEIGHT : 0),
    0,
    10,
  );
}

// Upsert by (teamId, targetHost): once seeded, the workspace carries a
// permanent sample fingerprint that next-trial loads can detect.
export async function seedTrialSample(teamId: string): Promise<void> {
  const targetHost = env.TRIAL_SAMPLE_TARGET_HOST;

  // Idempotent at the team level — reuse the existing sample scan if a
  // previous trial re-ran seedTrialSample on this team.
  const existing = await prisma.scan.findFirst({
    where: { teamId, target: targetHost, mode: 'tcp-only' },
    select: { id: true },
  });
  if (existing) return;

  const now = new Date();

  const scan = await prisma.scan.create({
    data: {
      target: targetHost,
      mode: 'tcp-only',
      status: 'completed',
      startedAt: now,
      finishedAt: now,
      teamId,
    },
  });

  const assetIds = new Map<number, string>();
  for (const a of SAMPLE_ASSETS) {
    const created = await prisma.asset.create({
      data: {
        scanId: scan.id,
        host: SAMPLE_HOST,
        ip: SAMPLE_IPS[a.port] ?? SAMPLE_HOST,
        port: a.port,
        protocol: a.protocol,
        state: a.state,
        latencyMs: a.latencyMs,
        serviceHint: a.serviceHint,
        banner: a.banner.slice(0, 500),
      },
    });
    assetIds.set(a.port, created.id);
  }

  for (const c of SAMPLE_CVES) {
    const assetId = assetIds.get(c.assetPort);
    if (!assetId) continue;

    // CveEntry is shared across all scans; upsert keyed on cveId. Description
    // is a stable placeholder so repeat seeds stay deterministic.
    await prisma.cveEntry.upsert({
      where: { cveId: c.cveId },
      create: {
        cveId: c.cveId,
        cvssScore: c.cvssScore,
        severity: c.severity,
        description: `Sample CVE pinned by ${brand.name} trial seed (${c.matchReason}).`,
        vector: null,
        publishedAt: now,
      },
      update: {
        cvssScore: c.cvssScore,
        severity: c.severity,
        description: `Sample CVE pinned by ${brand.name} trial seed (${c.matchReason}).`,
      },
    });

    await prisma.vulnerabilityFinding.create({
      data: {
        scanId: scan.id,
        assetId,
        cveId: c.cveId,
        severity: c.severity,
        matchReason: c.matchReason,
        priorityScore: computePriority(c),
        epssScore: c.epss,
        epssPercentile: c.epssPercentile,
        kevListed: c.kevListed,
        kevListedAt: c.kevListed ? now : null,
        vulncheckListed: c.vulncheckListed,
        vulncheckObservedAt: c.vulncheckListed ? now : null,
        lastRescoreAt: now,
        rescoreSource: 'trial-seed',
      },
    });
  }

  // Belt-and-suspenders: a fresh trial team's signup also seeds the
  // public /blog so the trialist lands inside an environment where the
  // blog page is already populated. The seed is keyed on slug (global),
  // so it short-circuits after the first call across all teams — calling
  // here is just a single findFirst on a re-trial.
  await seedBlogSample();
}
