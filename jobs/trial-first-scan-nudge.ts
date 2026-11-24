// @polsia:user-owned — trial-first-scan nudge cron entry. Hourly tick that
// finds trial workspaces whose owner has not run a first scan 24h after
// signup, then dispatches a single nudge email per owner.
//
// Selection + send logic lives in src/lib/business/trial-first-scan-nudge.ts
// so the cron entry itself stays small and the selector is unit-testable.
// See that file for the full gate semantics.
//
// Idempotency:
//   - The selector requires `lastFirstScanNudgeSentAt IS NULL` so a row
//     stamped in a prior tick will not be picked up.
//   - The send step stamps every workspace owned by a candidate in a
//     single updateMany — cheap and unambiguous if an owner ever owns
//     multiple workspaces.
//
// Soft-fail:
//   - Top-level try/catch swallows DB errors with a console breadcrumb so
//     a transient DB blip never crashes the cron.
//   - Per-candidate try/catch in the send step (delegated) so one bad
//     recipient does not abort the rest of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is a
// plain Node shell launched via `npx --yes tsx jobs/trial-first-scan-nudge.ts`.

import {
  findCandidates,
  sendNudgesForCandidates,
} from '../src/lib/business/trial-first-scan-nudge';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  const dashboardUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/dashboard`;

  // Cheap log seam so the cron produces an observable deploy-log
  // breadcrumb parity with the other crons.
  // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
  console.log(
    `[trial-first-scan-nudge] env=${env.NODE_ENV ?? 'unknown'} looking for eligible trial workspaces`,
  );

  let candidates: Awaited<ReturnType<typeof findCandidates>> = [];
  try {
    candidates = await findCandidates(now);
  } catch (err) {
    // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
    console.error('[trial-first-scan-nudge] selector failed', err);
    return;
  }
  // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
  console.log(`[trial-first-scan-nudge] ${candidates.length} candidate(s) to nudge`);

  try {
    const result = await sendNudgesForCandidates(candidates, { dashboardUrl });
    // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
    console.log(`[trial-first-scan-nudge] sent=${result.sent} skipped=${result.skipped}`);
  } catch (err) {
    // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
    console.error('[trial-first-scan-nudge] send failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[trial-first-scan-nudge] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[trial-first-scan-nudge] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
