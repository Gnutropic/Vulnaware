// @polsia:user-owned — GET /api/trial-status.
//
// Auth-gated. Server resolves the caller's team from the session — never
// trust a client-supplied teamId. Returns a TrialStatus shape the
// TrialExpiryBanner + OnboardingStepper islands consume.

import 'server-only';
import { NextResponse } from 'next/server';
import { trialStatusByTeam } from '@/lib/business/trial';
import { TrialStatus } from '@/lib/contracts/trial';
import { withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let user: SessionUser;
      try {
        user = await requireAuth(req);
      } catch (res) {
        return res as Response;
      }
      try {
        const status = await trialStatusByTeam(user.id);
        const out = TrialStatus.parse({
          active: status.active,
          trialEndsAt: status.trialEndsAt ? status.trialEndsAt.toISOString() : null,
          daysRemaining: status.daysRemaining,
          onboardingStep: status.onboardingStep,
          onboardingCompleted: status.onboardingCompleted,
        });
        return NextResponse.json(out);
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
