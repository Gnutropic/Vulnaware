// @polsia:user-owned — Nightly competitive-intelligence cron entry. For
// every Team, daily at 02:00 UTC (declared in polsia.toml), this entry:
//   1) gates by (teamId, startOfUtcDay(now)) so a re-fire within the
//      same UTC day is a no-op;
//   2) calls the LLM via `generateObject` from `@/lib/ai/client` with a
//      bounded zod response headline ≤ 280 / body ≤ 20_000 chars;
//   3) inserts a `CompetitiveIntelRun` row.
//
// Soft-fail layered at three levels so a transient blip never crashes
// the cron or aborts the batch for other teams:
//   - top-level try/catch swallows DB errors with a console breadcrumb
//   - per-team inner try/catch so one team's bad day does not abort
//     the rest of the batch
//   - the per-team orchestrator already skip-and-logs an AI failure
//     (does NOT insert a placeholder row — the listing must stay clean)
//
// Idempotency:
//   - `(teamId, ranAt)` is the unique key, with `ranAt` floored to
//     00:00:00.000Z of the UTC day. A second tick the same UTC day is
//     silently skipped. Retries triggered by the scheduler within the
//     same day also skip.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is
// a plain Node shell launched via `npx --yes tsx jobs/competitive-intel-run.ts`.

import { runNightlyCompetitiveIntelAudit } from '../src/lib/business/competitive-intel';
import { prisma } from '../src/lib/db';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  let result: Awaited<ReturnType<typeof runNightlyCompetitiveIntelAudit>> = {
    attempted: 0,
    inserted: 0,
    skipped: 0,
  };
  try {
    result = await runNightlyCompetitiveIntelAudit(now);
    // eslint-disable-next-line no-console -- intentional deploy-log breadcrumb
    console.log(
      `[competitive-intel-run] attempted=${result.attempted} inserted=${result.inserted} skipped=${result.skipped}`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console -- intentional deploy-log breadcrumb
    console.error('[competitive-intel-run] failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[competitive-intel-run] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[competitive-intel-run] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
