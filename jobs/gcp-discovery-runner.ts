// @polsia:user-owned — gcp-discovery-runner entry. Polls GcpDiscoveryRun for
// queued rows and drains them via the orchestrator. Runs under the platform
// cron in polsia.toml; not an in-process scheduler per AGENTS.md rules.
//
// NOTE: this file lives outside Next's bundled-TS context, so imports are
// RELATIVE (no `@/...` aliases — the cron command is a plain Node shell).

import { runGcpDiscovery } from '../src/lib/business/scanner/gcp-discovery/run-gcp-discovery';
import { prisma } from '../src/lib/db';

async function runOnce(): Promise<void> {
  try {
    const queued = await prisma.gcpDiscoveryRun.findMany({
      where: { status: 'queued' },
      orderBy: { startedAt: 'asc' },
      take: 1,
      select: { id: true },
    });
    const target = queued[0];
    if (!target) return;
    try {
      await runGcpDiscovery({ runId: target.id });
    } catch (err) {
      // Log loudly so missing SDKs / env vars / DB errors remain observable.
      console.error('[gcp-discovery-runner]', err);
    }
  } catch (err) {
    console.error('[gcp-discovery-runner]', err);
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  runOnce()
    .catch((err: unknown) => {
      console.error('[gcp-discovery-runner] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[gcp-discovery-runner] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
