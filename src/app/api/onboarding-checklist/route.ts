// @polsia:user-owned — GET + POST /api/onboarding-checklist.
//
// Powers the trial onboarding checklist card pinned to /dashboard.
// Both verbs resolve the caller's teamId server-side via Membership —
// the client never dictates which team to read. POST updates the
// singular `onboardingChecklistDismissedAt` stamp on TrialWorkspace
// and is idempotent (the timestamp just moves forward in time).
//
// Mirrors /api/trial-progress' wrapper posture: withRateLimit + withApiRequest,
// explicit 405 methodNotAllowed exports for non-GET/POST verbs, and the 500
// fallback sits inside withApiRequest so a thrown Error becomes {error}
// without leaking the stack.

import 'server-only';
import { NextResponse } from 'next/server';
import { dismissOnboardingChecklist, onboardingChecklistByTeam } from '@/lib/business/trial';
import { OnboardingChecklistResponse, OnboardingDismissResponse } from '@/lib/contracts/trial';
import { withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

async function resolveChecklist(req: Request): Promise<Response> {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const result = await onboardingChecklistByTeam(user.id);
  const parsed = OnboardingChecklistResponse.parse({
    steps: result.steps,
    completed: result.completed,
    dismissed: result.dismissed,
  });
  return NextResponse.json(parsed);
}

export async function GET(req: Request) {
  return withRateLimit(req, () => withApiRequest(req, () => resolveChecklist(req)));
}

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let user: SessionUser;
      try {
        user = await requireAuth(req);
      } catch (res) {
        return res as Response;
      }
      try {
        const stamp = await dismissOnboardingChecklist(user.id);
        if (stamp == null) {
          // Non-trial caller (no Membership or no TrialWorkspace row).
          // 404 lets the island fall back to hiding the card without
          // surfacing an error toast.
          return NextResponse.json({ error: 'No trial workspace' }, { status: 404 });
        }
        const parsed = OnboardingDismissResponse.parse({
          ok: true,
          dismissedAt: stamp.toISOString(),
        });
        return NextResponse.json(parsed);
      } catch (err) {
        // Prisma P2025 (record not found) reaches here when the
        // TrialWorkspace row was deleted under us; collapse it to
        // the same 404 the empty path returns so the island hides
        // the card consistently.
        const prismaErr = err as { code?: string };
        if (prismaErr?.code === 'P2025') {
          return NextResponse.json({ error: 'No trial workspace' }, { status: 404 });
        }
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
