// @polsia:user-owned — POST /api/analytics/events.
//
// Funnel-event ingest. Single route, `step` discriminator in body. Step 1
// (signup_page_view) is anonymous — just persist with the cookie-derived
// `anonymousId`. Steps 2-4 are authed: server resolves `userId` and
// `teamId` from the session + Membership, ignoring any client-sent
// values so a tampered request cannot point someone else's events at a
// different team.
//
// `cohort` and `experiment` are client-supplied labels so the dashboard
// nudge island can tag the rows it emits — they're NOT identity-bound
// and the server does not resolve them from session. Step 1 ignores
// either field entirely (anonymous visitors aren't cohort-bound).
//
// All writes are fire-and-forget. A slow DB must never block the signup
// form (step 1) or the dashboard nav (step 4). The handler returns
// `{ ok: true }` immediately after dispatching the write; logged errors
// from the helper sink into the structured-logger error stream.

import 'server-only';
import { NextResponse } from 'next/server';
import { recordTrialFunnelStep } from '@/lib/business/analytics';
import {
  TrialFunnelEventIngest,
  TrialFunnelEventIngestResponse,
  type TrialFunnelStep,
} from '@/lib/contracts/analytics';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

async function resolveTeamIdForUser(userId: string): Promise<string | null> {
  const membership = await prisma.membership.findUnique({
    where: { userId },
    select: { teamId: true },
  });
  return membership?.teamId ?? null;
}

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return NextResponse.json(
          { errors: { _: 'Request body must be valid JSON.' } },
          { status: 400 },
        );
      }

      const parsed = TrialFunnelEventIngest.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ errors: { _: 'Invalid analytics event' } }, { status: 400 });
      }

      const step: TrialFunnelStep = parsed.data.step;
      // Cohort/experiment are only meaningful on authed writes — step 1
      // ignores them so an anonymous visitor can't poison the A/B labels.
      const cohort = parsed.data.cohort ?? null;
      const experiment = parsed.data.experiment ?? null;

      if (step === 'signup_page_view') {
        // Public visitor beacon. Just persist with whatever
        // anonymousId the client supplied; cookie dedupe lives in the
        // island (180-day `polsia_signup_viewed` cookie), so a fresh
        // visitor lands here at most once.
        void recordTrialFunnelStep({
          step,
          anonymousId: parsed.data.anonymousId ?? null,
          // Explicitly drop cohort/experiment for the anonymous step so
          // the column defaults apply; passing them through would let
          // a fingerprinting client bias the segmented read.
          cohort: null,
          experiment: null,
        }).catch(() => undefined);
      } else {
        let user: SessionUser;
        try {
          user = await requireAuth(req);
        } catch (res) {
          return res as Response;
        }

        const teamId = await resolveTeamIdForUser(user.id);
        setRequestAuth({ userId: user.id, teamId });
        // Authed caller but no team (pre-trial seed race): skip the
        // write silently. The next page render will retry once the
        // /api/auth bootstrap-owner hook has attached a team.
        if (!teamId) {
          return new Response(null, { status: 204 });
        }

        void recordTrialFunnelStep({
          step,
          userId: user.id,
          teamId,
          cohort,
          experiment,
        }).catch(() => undefined);
      }

      return NextResponse.json(TrialFunnelEventIngestResponse.parse({ ok: true }));
    }),
  );
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
