// @polsia:user-owned — alert email dispatch cron entry. 5-minute tick that
// drains Alert rows whose dispatchedAt is still NULL (and whose createdAt
// has crossed the 60s grace period), emails each row's team-admin
// recipients via the alertEmail template, then stamps dispatchedAt.
//
// Selection + send logic lives in src/lib/business/alerts-dispatch.ts
// so the cron entry itself stays small and the selector is unit-testable.
// See that file for the full gate + stamp semantics.
//
// Idempotency:
//   - The selector requires `dispatchedAt IS NULL` and `createdAt <=
//     now - 60s`, so a row stamped in a prior tick is never picked up.
//
// Soft-fail:
//   - Top-level try/catch swallows DB errors with a console breadcrumb so
//     a transient DB blip never crashes the cron.
//   - Per-recipient try/catch in the send step (delegated) so one bad
//     admin does not abort the rest of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is a
// plain Node shell launched via `npx --yes tsx jobs/alert-dispatch.ts`.

import { findDispatchableAlerts, sendDispatchQueue } from '../src/lib/business/alerts-dispatch';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

  console.log(`[alert-dispatch] env=${env.NODE_ENV ?? 'unknown'} looking for dispatchable alerts`);

  let dispatchable: Awaited<ReturnType<typeof findDispatchableAlerts>> = [];
  try {
    dispatchable = await findDispatchableAlerts(now);
  } catch (err) {
    console.error('[alert-dispatch] selector failed', err);
    return;
  }
  console.log(`[alert-dispatch] ${dispatchable.length} candidate(s) to email`);

  try {
    const result = await sendDispatchQueue(dispatchable, now, { appBaseUrl });
    console.log(
      `[alert-dispatch] sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`,
    );
  } catch (err) {
    console.error('[alert-dispatch] send failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[alert-dispatch] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[alert-dispatch] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
