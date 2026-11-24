// @polsia:user-owned — configure better-auth here (spread into betterAuth() by @/lib/auth).
// Add emailAndPassword options, plugins, session, socialProviders, databaseHooks, etc.
// Framework owns db/secret/baseURL/admin() + the owner-admin grant (no-op if set here).
//
// Welcome email / signup side-effect (runs alongside the owner-admin grant — install `email`):
//   import { sendEmail } from '@/lib/email/send';
//   databaseHooks: { user: { create: { after: async (user) => {
//     await sendEmail({ to: user.email, subject: 'Welcome', html: '<p>Welcome!</p>' }).catch(() => {});
//   } } } },
// Add a plugin: `plugins: [organization()]` (admin() is added for you).
//
// Per-user fields (a `username`, profile, prefs): don't add a column to `User` (auth.prisma
// is locked) or use `user.additionalFields` (needs that locked column). Make a user-owned
// `prisma/schema/profile.prisma` (model UserProfile { userId String @unique /* fields */ },
// scalar userId) and create the row at signup:
//   import { prisma } from '@/lib/db';
//   databaseHooks: { user: { create: { after: async (user) => {
//     await prisma.userProfile.create({ data: { userId: user.id } }).catch(() => {});
//   } } } },

import type { BetterAuthOptions } from 'better-auth';
import { ensureDefaultWorkspace } from '@/lib/business/default-workspace';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { passwordResetEmail } from '@/lib/email/templates';
import { emitErrorLogEvent } from '@/lib/logging/logger';

// Idempotent per-user daily-digest bootstrap: for every new signup,
// ensure a DailyDigestPrefs row exists (column default `digestEnabled:
// true`). Runs alongside the workspace bootstrap so a brand-new user is
// opted in from minute 0 without an explicit /account visit. This optional
// preference write is best-effort and does not block signup.
async function ensureDailyDigestPrefsForUser(user: { id: string }): Promise<void> {
  try {
    await prisma.dailyDigestPrefs.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });
  } catch {
    // best-effort; never break signup's response chain.
  }
}

// Idempotent per-user subscription row bootstrap: for every new
// signup, ensure a UserSubscription row exists with the Starter
// (free) tier active. Mirror of ensureDailyDigestPrefsForUser: every
// new user is on Starter by default, then /billing/success or
// /api/billing/tier-subscribe flips them to Pro / Enterprise when
// their first transaction lands. Failures here MUST NOT block
// signup — same posture as the other two ensures.
async function ensureDefaultSubscriptionForUser(user: { id: string }): Promise<void> {
  try {
    await prisma.userSubscription.upsert({
      where: { userId: user.id },
      create: { userId: user.id, tier: 'starter', active: true },
      update: {},
    });
  } catch {
    // best-effort; never break signup's response chain.
  }
}

export const authConfig: BetterAuthOptions = {
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      try {
        const result = await sendEmail({
          to: user.email,
          ...passwordResetEmail({ resetUrl: url }),
        });

        if (!result.id) {
          emitErrorLogEvent({
            level: 'warn',
            msg: 'auth.password_reset.email_suppressed',
          });
        }
      } catch {
        // Better Auth must keep its account-neutral response when mail delivery fails.
        emitErrorLogEvent({
          level: 'error',
          msg: 'auth.password_reset.email_delivery_failed',
        });
      }
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Complete workspace creation before Better Auth returns signup success.
          await ensureDefaultWorkspace({ id: user.id, email: user.email });
          await ensureDailyDigestPrefsForUser(user as { id: string });
          await ensureDefaultSubscriptionForUser(user as { id: string });
        },
      },
    },
  },
};
