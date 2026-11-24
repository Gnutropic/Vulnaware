// @polsia:user-owned
//
// GET /api/account/active-plan
// Returns the signed-in user's active plan slug. The handler is
// auth-gated (any signed-in user can read); the resolution logic
// lives in src/lib/business/pricing.ts so the route stays thin.
//
//   200 → `{ plan: 'starter' | 'pro' | 'enterprise' | 'unknown', source: 'local' | 'proxy', status?: SubscriptionStatusResult }`
//   401 → `{ error: 'Unauthorized' }` (mirrors require-auth's thrown Response)
//
// Wrapped in `withRateLimit` so the read bucket (60/min per session
// cookie) keeps /account load on the proxy predictable — without it
// the active-plan re-validation in resolveActivePlan could amplify
// session-render load during page refresh loops.

import 'server-only';
import { NextResponse } from 'next/server';
import { resolveActivePlan } from '@/lib/business/pricing';
import { activePlanResponseSchema } from '@/lib/contracts/billing';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withRateLimit(req, async () => runActivePlan(req));
}

async function runActivePlan(req: Request): Promise<Response> {
  try {
    const user = await requireAuth(req);
    const result = await resolveActivePlan(user);
    const payload = activePlanResponseSchema.parse({
      plan: result.plan,
      source: result.source,
      ...(result.status ? { status: result.status } : {}),
    });
    return NextResponse.json(payload, { status: 200 });
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'active_plan_read_failed' }, { status: 503 });
  }
}
