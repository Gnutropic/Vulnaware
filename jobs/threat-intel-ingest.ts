// @polsia:user-owned — threat-intel-ingest cron entry. Drains the live
// KEV / EPSS / VulnCheck feeds on a per-feed cadence gated by the
// IntelFeedCursor row's `lastFetchedAt`. Runs under the platform cron in
// polsia.toml every 15 minutes; tighter per-feed intervals are respected
// in-process so EPSS (1h) only fires once per hour even if the cron is set
// to 15m.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is a
// plain Node shell launched via `npx --yes tsx jobs/threat-intel-ingest.ts`.

import { recordIntelError, rescoreByCveIds } from '../src/lib/business/scanner/live-rescore';
import { prisma } from '../src/lib/db';

// Pull cadences from env directly (no @/lib/env — relative-import constraint).
// Defaults mirror the env.ts declarations.
const POLL_MS = Number.parseInt(process.env.THREAT_INTEL_POLL_INTERVAL_MS ?? '', 10) || 15 * 60_000;
const EPSS_MS = Number.parseInt(process.env.THREAT_INTEL_EPSS_INTERVAL_MS ?? '', 10) || 60 * 60_000;
const VC_MS =
  Number.parseInt(process.env.THREAT_INTEL_VULNCHECK_INTERVAL_MS ?? '', 10) || 5 * 60_000;

const FEED_INTERVALS: Record<string, number> = {
  kev: POLL_MS,
  epss: EPSS_MS,
  vulncheck: VC_MS,
};

async function isDue(feed: string): Promise<boolean> {
  const cursor = await prisma.intelFeedCursor.findUnique({ where: { feed } });
  if (!cursor?.lastFetchedAt) return true;
  const interval = FEED_INTERVALS[feed] ?? POLL_MS;
  return Date.now() - cursor.lastFetchedAt.getTime() >= interval;
}

async function getCveIds(): Promise<string[]> {
  const findings = await prisma.vulnerabilityFinding.findMany({
    select: { cveId: true },
    distinct: ['cveId'],
  });
  return findings.map((f) => f.cveId);
}

async function runOnce(): Promise<void> {
  try {
    const [kevDue, epssDue, vcDue] = await Promise.all([
      isDue('kev'),
      isDue('epss'),
      isDue('vulncheck'),
    ]);

    if (!kevDue && !epssDue && !vcDue) return;

    const cveIds = await getCveIds();
    if (cveIds.length === 0) return;

    const findings = await prisma.vulnerabilityFinding.findMany({
      where: { cveId: { in: cveIds } },
      select: { id: true, cveId: true, priorityScore: true, scanId: true },
    });
    const rows = findings.map((f) => ({
      findingId: f.id,
      cveId: f.cveId,
      prevScore: f.priorityScore,
      scanId: f.scanId,
    }));

    if (kevDue) {
      try {
        await rescoreByCveIds(rows, { trigger: 'cron:kev' });
      } catch (err) {
        await recordIntelError('kev', String(err)).catch(() => undefined);
      }
    }

    if (epssDue) {
      try {
        await rescoreByCveIds(rows, { trigger: 'cron:epss' });
      } catch (err) {
        await recordIntelError('epss', String(err)).catch(() => undefined);
      }
    }

    if (vcDue) {
      try {
        await rescoreByCveIds(rows, { trigger: 'cron:vulncheck' });
      } catch (err) {
        await recordIntelError('vulncheck', String(err)).catch(() => undefined);
      }
    }
  } catch (err) {
    console.error('[threat-intel-ingest]', err);
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  runOnce()
    .catch((err: unknown) => {
      console.error('[threat-intel-ingest] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[threat-intel-ingest] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
