// @polsia:user-owned — trial-reminders cron entry. Sends D-7 / D-1 / D-0
// expiry emails for every active trial workspace.
//
// Idempotency: each reminder key is derived from `trialEndsAt` + the
// number of days remaining. We compare the last-sent stamp on the row
// to decide whether to fire — once per trial per cron tick.
//
// NOTE: relative imports only — no `@/...` aliases. The cron command is a
// plain Node shell launched via `npx --yes tsx jobs/trial-reminders.ts`.

import { brand } from '../src/lib/brand';
import { prisma } from '../src/lib/db';
import { sendEmail } from '../src/lib/email/send';
import { renderEmail } from '../src/lib/email/templates';
import { env } from '../src/lib/env';

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_OFFSETS_DAYS = [7, 1, 0] as const;

interface ReminderPlan {
  workspaceId: string;
  email: string;
  company: string;
  daysRemaining: number;
  trialEndsAt: Date;
}

function bucketKey(daysRemaining: number): number {
  // Bucket into the reminder offset (7 / 1 / 0). Anything outside those
  // is skipped — we don't spam at odd cadences.
  for (const offset of REMINDER_OFFSETS_DAYS) {
    if (daysRemaining === offset) return offset;
  }
  return -1;
}

function shouldFireToday(lastSentAt: Date | null, daysRemaining: number): boolean {
  if (!lastSentAt) return true;
  // Fire once per (workspace, day). The reminder bucket is keyed on the
  // number of days remaining, which is a discrete value per calendar day —
  // comparing the calendar date of lastSentAt to "today" is the right gate.
  const today = new Date();
  const sameDay =
    lastSentAt.getUTCFullYear() === today.getUTCFullYear() &&
    lastSentAt.getUTCMonth() === today.getUTCMonth() &&
    lastSentAt.getUTCDate() === today.getUTCDate();
  // Already fired today → no. Also if daysRemaining has changed since the
  // last fire (e.g. trial ended yesterday and we're now D-0) the offset
  // bucket differs, so allow.
  if (sameDay) return false;
  return daysRemaining === 0 || daysRemaining === 1 || daysRemaining === 7;
}

function buildReminderEmail(plan: ReminderPlan): {
  subject: string;
  html: string;
  text: string;
} {
  const endsAt = plan.trialEndsAt.toISOString().slice(0, 10);
  let heading: string;
  let body: string[];
  let footer: string;
  if (plan.daysRemaining <= 0) {
    heading = `Your ${brand.name} trial has ended`;
    body = [
      `Your ${brand.name} trial workspace ends today (${endsAt}). After today, the workspace becomes read-only — you can still review ranked findings, but new scans, key generation, and cloud account integrations pause.`,
      'Upgrade from inside the workspace to keep your team prioritized and your integrations live.',
    ];
    footer = 'This is your final reminder for this trial.';
  } else if (plan.daysRemaining === 1) {
    heading = `Your ${brand.name} trial ends tomorrow`;
    body = [
      `One day left on your trial — workspace access ends on ${endsAt}. Upgrade from inside the workspace to keep your ranked findings, API keys, and cloud account integrations active.`,
    ];
    footer = 'Reply to this email if you need help mapping your trial usage to a plan.';
  } else {
    heading = `${plan.daysRemaining} days left on your ${brand.name} trial`;
    body = [
      `Your trial workspace is still active and ends on ${endsAt}. This is a checkpoint so you can plan the conversion: export reports, invite the right teammates, and decide which integrations you'll keep.`,
    ];
    footer = 'You will receive another reminder the day before your trial ends.';
  }
  const { html, text } = renderEmail({
    heading,
    body,
    footer,
  });
  return { subject: heading, html, text };
}

async function processWorkspace(plan: ReminderPlan): Promise<void> {
  if (!shouldFireToday(null, plan.daysRemaining)) return;

  const email = buildReminderEmail(plan);
  try {
    await sendEmail({
      to: plan.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    await prisma.trialWorkspace.update({
      where: { id: plan.workspaceId },
      data: { lastReminderSentAt: new Date() },
    });
  } catch {
    // Swallow — never let a transient email-proxy failure crash the cron.
    // The next tick will retry the same bucket.
  }
}

async function loadPlans(): Promise<ReminderPlan[]> {
  const now = Date.now();
  const trials = await prisma.trialWorkspace.findMany({
    where: {
      trialEndsAt: {
        gte: new Date(now - DAY_MS), // include those that ended yesterday
        lte: new Date(now + 7 * DAY_MS),
      },
    },
    select: {
      id: true,
      ownerUserId: true,
      trialEndsAt: true,
      lastReminderSentAt: true,
    },
  });
  if (trials.length === 0) return [];

  const ownerIds = Array.from(new Set(trials.map((t) => t.ownerUserId)));
  const owners = await prisma.user.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, email: true, name: true },
  });
  const ownerMap = new Map(owners.map((o) => [o.id, o] as const));

  const plans: ReminderPlan[] = [];
  for (const t of trials) {
    const daysRemaining = Math.ceil((t.trialEndsAt.getTime() - now) / DAY_MS);
    if (bucketKey(daysRemaining) === -1) continue;
    if (!shouldFireToday(t.lastReminderSentAt, daysRemaining)) continue;
    const owner = ownerMap.get(t.ownerUserId);
    if (!owner?.email) continue;
    plans.push({
      workspaceId: t.id,
      email: owner.email,
      company: owner.name ?? 'there',
      daysRemaining,
      trialEndsAt: t.trialEndsAt,
    });
  }
  return plans;
}

async function main(): Promise<void> {
  // Cheap log seam so the cron produces something observable in deploy logs.
  // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
  console.log(
    `[trial-reminders] env=${env.NODE_ENV ?? 'unknown'} looking for D-7/D-1/D-0 workspaces`,
  );
  const plans = await loadPlans();
  // eslint-disable-next-line no-console -- intentionally a deploy-log breadcrumb
  console.log(`[trial-reminders] ${plans.length} reminder(s) to dispatch`);
  for (const plan of plans) {
    await processWorkspace(plan);
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  main()
    .catch((err: unknown) => {
      console.error('[trial-reminders] uncaught', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error('[trial-reminders] prisma disconnect failed', err);
        process.exitCode = 1;
      }
    });
}
