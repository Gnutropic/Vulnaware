// @polsia:user-owned — nightly alert digest cron entry. 07:00 UTC tick that
// summarises every Team's open critical/high `Alert` rows from the last
// 24 hours and emails the digest to all active WorkspaceMember addresses
// via the alertDigestEmail template, then stamps Team.lastAlertDigestAt
// so the next tick is a UTC-day idempotent no-op. Empty-day teams still
// fire an all-clear branch exactly once per UTC day so members learn the
// digest pattern.
//
// Selection + send logic lives in src/lib/business/alerts-digest.ts
// so the cron entry itself stays small and the selector is unit-testable.
// See that file for the full gate + stamp semantics.
//
// Idempotency:
//   - The selector requires `digestEnabled === true` (column default is
//     `true`, so legacy rows opt-in post-`prisma db push`).
//   - `sendDigests` reads Team.lastAlertDigestAt at send time and skips
//     teams whose UTC stamp already matches today's calendar date — the
//     canonical once-per-UTC-day guarantee.
//
// Soft-fail:
//   - Top-level try/catch swallows selector and sender errors with a
//     console breadcrumb so a transient DB blip never crashes the cron.
//   - Per-team error isolation is delegated to the sender so one bad
//     team does not abort the rest of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is a
// plain Node shell launched via `npx --yes tsx jobs/alert-digest.ts`.

import { findAlertDigestInputs, sendDigests } from '../src/lib/business/alerts-digest';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

  console.log(`[alert-digest] env=${env.NODE_ENV ?? 'unknown'} looking for digests to email`);

  let inputs: Awaited<ReturnType<typeof findAlertDigestInputs>> = [];
  try {
    inputs = await findAlertDigestInputs(now);
  } catch (err) {
    console.error('[alert-digest] selector failed', err);
    return;
  }
  console.log(`[alert-digest] ${inputs.length} team(s) to consider`);

  try {
    const result = await sendDigests(inputs, now, { appBaseUrl });
    console.log(
      `[alert-digest] sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`,
    );
  } catch (err) {
    console.error('[alert-digest] send failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[alert-digest] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[alert-digest] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
