// @polsia:user-owned — Weekly risk-trend email digest cron entry.
// 08:00 UTC Monday tick that reads each Team's latest VulnerabilityTrend
// signal + last-7d Alert slice, asks the platform's Agent API to draft
// an executive-style analyst digest, and emails the result via the
// email proxy to every active WorkspaceMember address.
//
// 08:00 UTC fires 2h AFTER the 06:00 alerts-trend tick so the digest
// can reference today's fresh signal in its prompt context.
//
// Selection + send logic lives in src/lib/business/weekly-risk-digest.ts
// so the cron stays small AND the writer is unit-testable in isolation.
// See that file for the full Gate + dedupe + AI-fail semantics.
//
// Soft-fail posture:
//   - Top-level try/catch swallows writer errors with a console
//     breadcrumb so a transient DB blip never crashes the cron.
//   - Per-team error isolation is delegated to the writer so one bad
//     team does NOT abort the rest of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command
// is a plain Node shell launched via `npx --yes tsx jobs/weekly-risk-digest.ts`.

import { runWeeklyRiskDigest } from '../src/lib/business/weekly-risk-digest';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

  console.log(
    `[weekly-risk-digest] env=${env.NODE_ENV ?? 'unknown'} sending weekly analyst digests`,
  );

  try {
    const result = await runWeeklyRiskDigest(now, {
      triggeredBy: 'cron',
      appBaseUrl,
    });
    console.log(
      `[weekly-risk-digest] sent=${result.sent} failed=${result.failed} skipped=${result.skipped} attempted=${result.attempted}`,
    );
  } catch (err) {
    console.error('[weekly-risk-digest] writer failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[weekly-risk-digest] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[weekly-risk-digest] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
