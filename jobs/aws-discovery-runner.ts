// @polsia:user-owned — aws-discovery-runner entry. Polls AwsDiscoveryRun for
// queued rows and drains them via the orchestrator. Runs under the platform
// cron in polsia.toml; not an in-process scheduler per AGENTS.md rules.
//
// NOTE: this file lives outside Next's bundled-TS context, so imports are
// RELATIVE (no `@/...` aliases — the cron command is a plain Node shell).

import { runAwsDiscovery } from '../src/lib/business/scanner/aws-discovery/run-aws-discovery';
import { prisma } from '../src/lib/db';

async function runOnce(): Promise<void> {
  try {
    const queued = await prisma.awsDiscoveryRun.findMany({
      where: { status: 'queued' },
      orderBy: { startedAt: 'asc' },
      take: 1,
      select: { id: true },
    });
    const target = queued[0];
    if (!target) return;
    try {
      await runAwsDiscovery({ runId: target.id });
    } catch {
      // Orchestrator already records the failure on the run row; swallow
      // so one bad run doesn't kill the cron invocation.
    }
  } catch (err) {
    console.error('[aws-discovery-runner]', err);
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  runOnce()
    .catch((err: unknown) => {
      console.error('[aws-discovery-runner] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[aws-discovery-runner] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
