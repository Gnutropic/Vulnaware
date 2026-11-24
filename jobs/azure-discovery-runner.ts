// @polsia:user-owned — azure-discovery-runner entry. Polls AzureDiscoveryRun
// for queued rows and drains them via the orchestrator. Runs under the
// platform cron in polsia.toml; not an in-process scheduler per AGENTS.md
// rules.
//
// NOTE: this file lives outside Next's bundled-TS context, so imports are
// RELATIVE (no `@/...` aliases — the cron command is a plain Node shell).

import { runAzureDiscovery } from '../src/lib/business/scanner/azure-discovery/run-azure-discovery';
import { prisma } from '../src/lib/db';

async function runOnce(): Promise<void> {
  try {
    const queued = await prisma.azureDiscoveryRun.findMany({
      where: { status: 'queued' },
      orderBy: { startedAt: 'asc' },
      take: 1,
      select: { id: true },
    });
    const target = queued[0];
    if (!target) return;
    try {
      await runAzureDiscovery({ runId: target.id });
    } catch (err) {
      // The orchestrator records the failure on the run row; log it so
      // missing SDK packages, env vars, or DB issues remain observable.
      console.error('[azure-discovery-runner]', err);
    }
  } catch (err) {
    console.error('[azure-discovery-runner]', err);
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  runOnce()
    .catch((err: unknown) => {
      console.error('[azure-discovery-runner] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[azure-discovery-runner] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
