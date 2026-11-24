// @polsia:user-owned — Server-only pricing resolution helpers. Imports
// server-only modules (`@/lib/db`, `@/lib/stripe-billing/client`,
// `@/lib/require-auth`) so it cannot be pulled into a `'use client'`
// file's import graph — the `'server-only'` import enforces that. The
// only call sites are the route handlers this plan adds (and any other
// authenticated server-side lookup). The page body / component tree
// must NEVER import this file directly; they reach the data plane via
// `/api/<resource>` + `apiFetch` and consume this only indirectly
// through the route.
//
// Three helpers:
//
//   * `resolvePricingCatalogEntry(tier)` → serverCatalog row + slug guard.
//   * `deriveTierSlugFromSearchParams(sp)` → safe parser for the
//     `?tier=` URL param used by /billing/success and friends.
//   * `resolveActivePlan(user)` → the user's plan seam consumed by
//     `/api/account/active-plan`. Composes a DB read + a best-effort
//     proxy re-validation so the route handler stays a one-liner.
//
// Re-validation cadence: when the local row is `tier:'pro' && active`,
// and `lastVerifiedAt` is older than `REVALIDATE_AFTER_MS` (default 5
// minutes), the helper hits `getSubscriptionStatus` and, if the proxy
// says inactive, drops the local row's `active` flag before returning.
// This is the cancel/dispute defence — without it a buyer who cancels
// in the Stripe portal keeps their Pro row forever because the success
// page only writes once.

import 'server-only';
import { prisma } from '@/lib/db';
import {
  type PricingTierSlug,
  type ServerCatalogEntry,
  type ServerCatalogKind,
  serverCatalog,
} from '@/lib/pricing-tiers';
import { getSessionUser, type SessionUser } from '@/lib/require-auth';
import {
  getSubscriptionStatus,
  StripeBillingConfigurationError,
  StripeBillingNotEnabledError,
  StripeBillingOnboardingError,
} from '@/lib/stripe-billing/client';
import type { SubscriptionStatusResult } from '@/lib/stripe-billing/schema';

const TIER_SLUGS: readonly PricingTierSlug[] = ['starter', 'pro', 'enterprise'];

// 5 minutes — short enough that a cancelled buyer's row flips to
// 'starter' shortly after the next /api/account/active-plan call, but
// long enough that the proxy isn't hammered on every page render.
const REVALIDATE_AFTER_MS = 5 * 60_000;

export function resolvePricingCatalogEntry(tier: string): ServerCatalogEntry | null {
  if (!TIER_SLUGS.includes(tier as PricingTierSlug)) return null;
  return serverCatalog[tier as PricingTierSlug];
}

export function deriveTierSlugFromSearchParams(
  sp: Record<string, string | string[] | undefined>,
): PricingTierSlug | null {
  const raw = sp.tier;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (!TIER_SLUGS.includes(value as PricingTierSlug)) return null;
  return value as PricingTierSlug;
}

export interface ResolveActivePlanResult {
  plan: PricingTierSlug | 'unknown';
  source: 'local' | 'proxy';
  status?: SubscriptionStatusResult;
}

async function revalidateAgainstProxy(
  user: SessionUser,
  rowLastVerifiedAt: Date | null,
): Promise<SubscriptionStatusResult | null> {
  // Skip the proxy when the row is fresh enough — this protects the
  // /account dashboard from hammering the proxy on every render.
  if (rowLastVerifiedAt) {
    const ageMs = Date.now() - rowLastVerifiedAt.getTime();
    if (ageMs < REVALIDATE_AFTER_MS) {
      return null;
    }
  }
  if (!user.email) return null;
  try {
    return await getSubscriptionStatus({ email: user.email });
  } catch (err) {
    if (
      err instanceof StripeBillingNotEnabledError ||
      err instanceof StripeBillingConfigurationError ||
      err instanceof StripeBillingOnboardingError
    ) {
      return null;
    }
    // Generic read failure — leave the row intact rather than dropping
    // active:true on a transient failure.
    return null;
  }
}

async function dropProRow(userId: string): Promise<void> {
  try {
    await prisma.userSubscription.update({
      where: { userId },
      data: { active: false, lastVerifiedAt: new Date() },
    });
  } catch {
    // Best-effort: even if the update fails, the resolveActivePlan
    // return path below drops to 'starter' for this read.
  }
}

export async function resolveActivePlan(user: SessionUser): Promise<ResolveActivePlanResult> {
  const row = await prisma.userSubscription.findUnique({ where: { userId: user.id } });
  if (row?.active && row.tier === 'pro') {
    // Re-validate Pro rows against the proxy when `lastVerifiedAt`
    // is older than REVALIDATE_AFTER_MS (or was never set). If the
    // proxy says inactive, drop `active` and fall through to the
    // proxy-or-unknown branch.
    const fresh = await revalidateAgainstProxy(user, row.lastVerifiedAt);
    if (fresh && fresh.active === false) {
      await dropProRow(user.id);
      // Fall through — don't return early so the buyer gets a
      // 'starter' read on this page render.
    } else {
      // Row is fresh OR the proxy agrees it's active. Bump
      // `lastVerifiedAt` so the next read doesn't immediately re-hit.
      if (fresh && fresh.active === true) {
        try {
          await prisma.userSubscription.update({
            where: { userId: user.id },
            data: { lastVerifiedAt: new Date() },
          });
        } catch {
          // non-fatal
        }
      }
      return { plan: 'pro', source: 'local', status: fresh ?? undefined };
    }
  }

  if (row?.active) {
    const slug = TIER_SLUGS.find((s) => s === row.tier);
    if (slug) {
      return { plan: slug, source: 'local' };
    }
  }

  // Local row absent / inactive → try the live proxy. Best-effort:
  // typed Stripe-billing errors degrade to 'unknown' so /account shows
  // the "Subscription unavailable" card instead of throwing.
  if (!user.email) {
    return { plan: 'unknown', source: 'proxy' };
  }
  try {
    const status = await getSubscriptionStatus({ email: user.email });
    if (status.active) {
      return { plan: 'pro', source: 'proxy', status };
    }
    return { plan: 'starter', source: 'proxy', status };
  } catch (err) {
    if (
      err instanceof StripeBillingNotEnabledError ||
      err instanceof StripeBillingConfigurationError ||
      err instanceof StripeBillingOnboardingError
    ) {
      return { plan: 'unknown', source: 'proxy' };
    }
    return { plan: 'unknown', source: 'proxy' };
  }
}

// Re-export so route handlers can do `import { getSessionUser, type SessionUser } from '@/lib/business/pricing'`
// without a second import line for the auth seam.
export { getSessionUser, type SessionUser };

export type { ServerCatalogKind, ServerCatalogEntry };
