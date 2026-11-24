// @polsia:user-owned — GET /api/analytics/trial.
//
// Funnel-rate aggregator. Two scopes, controlled by the `crossTeam`
// query param:
//   - default (no param): team-scoped — mirror /api/trial-progress. The
//     caller's team is resolved from `Membership` and only events for
//     that `teamId` are counted. Signed-in callers without a team get
//     an empty (all-zeros) payload — never a 404, which would break
//     the dashboard render.
//   - `?crossTeam=1`: requires the caller to be a better-auth admin.
//     Aggregates every row in TrialFunnelEvent; this is the BI-free
//     escape hatch for the product team. Per AGENTS.md the failure
//     shape is 403 JSON — never a redirect — because the route is
//     called via fetch from a client island, not navigated to directly.
//
// Optional query filters `cohort` / `experiment` / `windowStart` /
// `windowEnd` narrow BOTH scopes. Cohort and experiment filters require
// an admin session regardless of `crossTeam` so non-admin callers can't
// mine cohort rates across teams; the silently-downgrade-to-default
// fallback applies when the requester isn't admin. Window filters are
// safe for everyone (they only narrow the time range of an already
// team-allowed read).
//
// Counts come from a single `groupBy('step')._count`, rates are
// derived in-process. `TrialAnalyticsResponse.parse` is the last
// step so any future schema drift fails loudly at the boundary.

import 'server-only';
import type { Prisma } from '@prisma/client';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  TrialAnalyticsCohortFilter,
  TrialAnalyticsResponse,
  type TrialFunnelStep as TrialFunnelStepValue,
} from '@/lib/contracts/analytics';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const STEP_ORDER: TrialFunnelStepValue[] = [
  'signup_page_view',
  'trial_workspace_created',
  'first_scan_triggered',
  'dashboard_viewed',
  'cloud_nudge_shown',
  'cloud_nudge_clicked',
];

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function zeroCounts(): Record<TrialFunnelStepValue, number> {
  return {
    signup_page_view: 0,
    trial_workspace_created: 0,
    first_scan_triggered: 0,
    dashboard_viewed: 0,
    cloud_nudge_shown: 0,
    cloud_nudge_clicked: 0,
  };
}

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      let user: SessionUser;
      try {
        user = await requireAuth(req);
      } catch (res) {
        return res as Response;
      }

      const url = new URL(req.url);
      const crossTeam = url.searchParams.get('crossTeam') === '1';

      // Parse optional cohort filter from query string. safeParse lets
      // bogus values degrade to the unscoped default rather than 400ing
      // the island (a malformed query is a data-quality issue, not an
      // auth failure).
      const filterParsed = TrialAnalyticsCohortFilter.safeParse({
        cohort: url.searchParams.get('cohort') ?? undefined,
        experiment: url.searchParams.get('experiment') ?? undefined,
        windowStart: url.searchParams.get('windowStart') ?? undefined,
        windowEnd: url.searchParams.get('windowEnd') ?? undefined,
      });
      const filter = filterParsed.success ? filterParsed.data : {};
      const wantsCohortFilter = filter.cohort != null || filter.experiment != null;
      const wantsWindowFilter = filter.windowStart != null || filter.windowEnd != null;

      // Cohort + experiment filtering is admin-only regardless of
      // crossTeam — a non-admin caller can otherwise infer cohort
      // membership by toggling ?cohort=nudge_v1 on their own-team
      // scoped reads, so we drop the filter silently for them.
      let isAdmin = false;
      if (wantsCohortFilter || crossTeam) {
        // Direct session read so the failure path is JSON, not a
        // redirect Response. requireAdmin() (from @/lib/require-admin)
        // is for Server Components and uses redirect() — wrong shape
        // for an API route.
        const adminSession = await auth.api.getSession({ headers: await headers() });
        if (!adminSession?.user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (adminSession.user.role !== 'admin') {
          if (crossTeam) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          }
          // Non-admin with cohort filter: silently downgrade to the
          // unscoped team read. Window filters are safe to keep.
        } else {
          isAdmin = true;
        }
      }

      let scopeTeamId: string | null;
      if (crossTeam && isAdmin) {
        scopeTeamId = null;
        setRequestAuth({ userId: user.id, teamId: null });
      } else {
        const membership = await prisma.membership.findUnique({
          where: { userId: user.id },
          select: { teamId: true },
        });
        scopeTeamId = membership?.teamId ?? null;
        setRequestAuth({ userId: user.id, teamId: scopeTeamId });
      }

      try {
        const where: Prisma.TrialFunnelEventWhereInput = {};
        if (scopeTeamId) {
          where.teamId = scopeTeamId;
        }
        if (isAdmin && wantsCohortFilter) {
          if (filter.cohort != null) where.cohort = filter.cohort;
          if (filter.experiment != null) where.experiment = filter.experiment;
        }
        if (wantsWindowFilter) {
          const createdAt: { gte?: Date; lte?: Date } = {};
          if (filter.windowStart) createdAt.gte = new Date(filter.windowStart);
          if (filter.windowEnd) createdAt.lte = new Date(filter.windowEnd);
          if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;
        }

        const rows = await prisma.trialFunnelEvent.groupBy({
          by: ['step'],
          _count: { _all: true },
          where,
        });

        const counts = zeroCounts();
        for (const row of rows) {
          const step = row.step as TrialFunnelStepValue;
          if (STEP_ORDER.includes(step)) {
            counts[step] = row._count._all;
          }
        }

        // Core funnel edges (step 1→2, 2→3, 3→4) ignore the nudge
        // steps — they're instrumentation, not funnel conversions.
        const entered1 = counts.signup_page_view;
        const completed1 = counts.trial_workspace_created;
        const entered2 = counts.trial_workspace_created;
        const completed2 = counts.first_scan_triggered;
        const entered3 = counts.first_scan_triggered;
        const completed3 = counts.dashboard_viewed;

        const rates = [
          {
            from: 'signup_page_view' as const,
            to: 'trial_workspace_created' as const,
            entered: entered1,
            completed: completed1,
            rate: safeRate(completed1, entered1),
          },
          {
            from: 'trial_workspace_created' as const,
            to: 'first_scan_triggered' as const,
            entered: entered2,
            completed: completed2,
            rate: safeRate(completed2, entered2),
          },
          {
            from: 'first_scan_triggered' as const,
            to: 'dashboard_viewed' as const,
            entered: entered3,
            completed: completed3,
            rate: safeRate(completed3, entered3),
          },
        ];

        const payload = TrialAnalyticsResponse.parse({
          windowStart: (filter.windowStart ?? new Date().toISOString()).toString(),
          counts,
          rates,
          partial: {
            step1To2: safeRate(completed1, entered1),
            step2To3: safeRate(completed2, entered2),
            step3To4: safeRate(completed3, entered3),
          },
        });

        return NextResponse.json(payload);
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
