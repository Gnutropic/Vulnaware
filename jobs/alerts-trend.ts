// @polsia:user-owned — daily CVE velocity trend cron entry. 06:00 UTC tick
// that aggregates the last 30d vs prior 30d of Alert rows per Team and
// upserts a VulnerabilityTrend row keyed on (workspaceId, windowStart).
// 06:00 UTC fires 1h before the 07:00 alert-digest so that digest can
// reference today's signal in downstream renderers.
//
// Selection + write logic lives in src/lib/business/alerts-trend.ts so
// the cron entry itself stays small AND the writer is unit-testable in
// isolation. See that file for the full window + idempotency posture.
//
// Soft-fail:
//   - Top-level try/catch swallows writer errors with a console breadcrumb
//     so a transient DB blip never crashes the cron. Per-team errors are
//     counted inside the writer so one bad team does NOT abort the rest
//     of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is
// a plain Node shell launched via `npx --yes tsx jobs/alerts-trend.ts`.

import { recordWorkspaceTrends } from '../src/lib/business/alerts-trend';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  process.stdout.write(`[alerts-trend] env=${env.NODE_ENV ?? 'unknown'} computing trend signals\n`);

  try {
    const result = await recordWorkspaceTrends(now);
    process.stdout.write(`[alerts-trend] written=${result.written} failed=${result.failed}\n`);
  } catch (err) {
    process.stderr.write(`[alerts-trend] writer failed ${String(err)}\n`);
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      process.stderr.write(`[alerts-trend] uncaught ${String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        process.stderr.write(`[alerts-trend] prisma disconnect failed ${String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
