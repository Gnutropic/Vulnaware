// @polsia:user-owned — per-user daily digest cron entry. 08:30 UTC
// tick that emails each opted-in user a summary of NEW alerts created
// in the last 24 hours that are owned by the recipient OR are
// unassigned (waiting to be picked up). One envelope per user per UTC
// day; the per-user `lastSentAt` stamp advances on a successful send
// so a re-tick within the same UTC calendar day is a no-op.
//
// Selection + send logic lives in
// src/lib/business/daily-user-digest.ts so the cron entry stays
// small AND the selector is unit-testable. See that file for the
// stamp + per-user error-isolation semantics.
//
// Sits alongside the 09:00 per-team daily alert digest: same
// `[daily digest]` subject prefix but a per-user recipient
// (one envelope per opted-in user instead of per team roster), a
// different temporal filter (24h createdAt, no status-changed
// branch), different ownership scope (ownerId=user OR IS NULL
// instead of team-wide), and its OWN per-user `lastSentAt` stamp
// column so a busy day for one user cannot silence the cadence for
// anyone else in the same team.
//
// Idempotency:
//   - The selector requires `DailyDigestPrefs.digestEnabled === true`
//     (column default is `true`, so legacy rows opt-in post-`prisma
//     db push`).
//   - `sendDailyUserDigests` reads DailyDigestPrefs.lastSentAt at
//     send time and skips users whose UTC stamp already matches
//     today's calendar date — the canonical once-per-UTC-day
//     guarantee.
//
// Soft-fail:
//   - Top-level try/catch swallows selector and sender errors with a
//     console breadcrumb so a transient DB blip never crashes the
//     cron.
//   - Per-user error isolation is delegated to the sender so one
//     bad recipient does not abort the rest of the batch.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is
// a plain Node shell launched via `npx --yes tsx jobs/daily-user-digest.ts`.

import {
  findDailyUserDigestInputs,
  sendDailyUserDigests,
} from '../src/lib/business/daily-user-digest';
import { prisma } from '../src/lib/db';
import { env } from '../src/lib/env';

export async function main(nowArg?: Date): Promise<void> {
  const now = nowArg ?? new Date();
  const appBaseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');

  console.log(
    `[daily-user-digest] env=${env.NODE_ENV ?? 'unknown'} looking for user digests to email`,
  );

  let inputs: Awaited<ReturnType<typeof findDailyUserDigestInputs>> = [];
  try {
    inputs = await findDailyUserDigestInputs(now);
  } catch (err) {
    console.error('[daily-user-digest] selector failed', err);
    return;
  }
  console.log(`[daily-user-digest] ${inputs.length} user(s) to consider`);

  try {
    const result = await sendDailyUserDigests(inputs, now, { appBaseUrl });
    console.log(
      `[daily-user-digest] sent=${result.sent} failed=${result.failed} skipped=${result.skipped} attempted=${result.attempted}`,
    );
  } catch (err) {
    console.error('[daily-user-digest] send failed', err);
  }
}

// Auto-invoke is suppressed under vitest so the test harness can drive
// `main()` directly. Production cron runs never set VITEST/NODE_ENV=test.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[daily-user-digest] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[daily-user-digest] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
