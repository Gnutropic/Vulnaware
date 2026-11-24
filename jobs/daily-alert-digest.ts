// @polsia:user-owned — daily alert digest cron entry. 09:00 UTC tick
// that summarises every Team's last-24h alerts (created OR status-
// changed) across ALL four severities into a clean per-team envelope
// with severity count lines + per-row /alerts?ownedByMe=1 deep links,
// then stamps Team.lastDailyDigestAt so the next tick is a UTC-day
// idempotent no-op. Empty-day teams still fire an all-clear branch
// exactly once per UTC day so members learn the digest pattern.
//
// Selection + send logic lives in src/lib/business/daily-alert-digest.ts
// so the cron entry itself stays small AND the selector is unit-testable.
// See that file for the gate + stamp + per-tenant-count semantics.
//
// Sits alongside the 07:00 nightly alert-digest cron: different
// severity scope (every severity vs critical/high only), different
// temporal filter (last-24h created OR status-changed vs unack'd
// last-24h), different link target (/alerts?ownedByMe=1 vs /alerts/[id]),
// and its OWN `Team.lastDailyDigestAt` stamp column so a busy day
// cannot suppress the 09:00 cadence on the shared nightly stamp.
//
// Idempotency:
//   - The selector requires `dailyDigestEnabled === true` (column
//     default is `true`, so legacy rows opt-in post-`prisma db push`).
//   - `sendDailyDigests` reads Team.lastDailyDigestAt at send time
//     and skips teams whose UTC stamp already matches today's calendar
//     date — the canonical once-per-UTC-day guarantee.
//
// Soft-fail:
//   - Top-level try/catch swallows selector and sender errors with a
//     console breadcrumb so a transient DB blip never crashes the cron.
//   - Per-team error isolation is delegated to the sender so one bad
//     team does not abort the rest of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is
// a plain Node shell launched via `npx --yes tsx jobs/daily-alert-digest.ts`.

import { findDailyDigestInputs, sendDailyDigests } from '../src/lib/business/daily-alert-digest';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

  console.log(
    `[daily-alert-digest] env=${env.NODE_ENV ?? 'unknown'} looking for daily digests to email`,
  );

  let inputs: Awaited<ReturnType<typeof findDailyDigestInputs>> = [];
  try {
    inputs = await findDailyDigestInputs(now);
  } catch (err) {
    console.error('[daily-alert-digest] selector failed', err);
    return;
  }
  console.log(`[daily-alert-digest] ${inputs.length} team(s) to consider`);

  try {
    const result = await sendDailyDigests(inputs, now, { appBaseUrl });
    console.log(
      `[daily-alert-digest] sent=${result.sent} failed=${result.failed} skipped=${result.skipped} attempted=${result.attempted}`,
    );
  } catch (err) {
    console.error('[daily-alert-digest] send failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[daily-alert-digest] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[daily-alert-digest] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
