// @polsia:user-owned — Chip-list source for the /alerts page's asset
// chip row. Returns the team's top-N distinct assets by alert frequency,
// ordered by `count` desc then `name` asc as the tiebreak. Same gate as
// `/api/alerts` (`requireTeamRole('member')` + `setRequestAuth` first +
// `teamId` server-seeded) — an anonymous caller gets 401, a non-team-
// member caller gets 403.
//
// Why this lives at `/api/alerts/asset-options` (NOT under `/api/assets`):
//   - The route is owned by the alerts page's UX, not the /assets
//     rollup table. A future decline in the /assets team's contract
//     shouldn't force a chip-row rewrite on /alerts, and vice versa.
//   - `/api/assets` returns a paginated rollup with full severity
//     breakdown + firstSeen / lastSeen — more wire surface than the
//     chip needs the chip row only reads `{ name, count }`.
//   - Static route segment, so the order in which Next.js matches
//     `/api/alerts/[id]` vs `/api/alerts/asset-options` resolves to
//     the more-specific (static) one with no dynamic-id ambiguity.
//
// Reduce-in-app pattern mirrors `@/app/api/assets/route.ts:115-144` —
// we cannot use Prisma `groupBy({ by: ['finding.asset.host'] })` because
// relation columns are not accepted as `by` keys, so the rollup is
// computed in code: read up to MAX_ROWS alert rows joined to the finding's
// asset, reduce by composite `${host}:${port}/${protocol}` key, count
// per asset, then sort + slice.
//
// `?limit=N` parameter (default 200) bounds the response size and is
// what the chip row uses to drive the top-N display + overflow pill.

import 'server-only';
import { NextResponse } from 'next/server';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { AssetFilterOptions } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 100_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireTeamRole>>;
    try {
      ctx = await requireTeamRole('member');
    } catch (res) {
      return res as Response;
    }

    const workspaceContext = await resolveDashboardWorkspaceContext(ctx.user.id);
    if (!workspaceContext) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 404 });
    }
    setRequestAuth({ userId: ctx.user.id, teamId: workspaceContext.workspaceId });

    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (limitParam != null && limitParam.length > 0) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return NextResponse.json(
          {
            error: 'bad_request',
            message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
          },
          { status: 400 },
        );
      }
      limit = parsed;
    }
    const teamId = workspaceContext.workspaceId;

    // Same posture as `/api/assets/route.ts`: `findingId: { not: 'manual' }`
    // strips manual rows so the composite-key reduce never sees an
    // undefined host (a manual row has no underlying Asset).
    const where = {
      teamId,
      findingId: { not: 'manual' },
    };

    try {
      const rows = await prisma.alert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
        select: {
          finding: {
            select: {
              asset: { select: { host: true, port: true, protocol: true } },
            },
          },
        },
      });

      // In-app reduce — count distinct composite keys. Name comes from the
      // same `${host}:${port}/${protocol}` template the /assets route uses,
      // so the chip row + the assets rollup read + write the same shape
      // and the /assets → /alerts deep-link round-trips byte-for-byte.
      const countByName = new Map<string, number>();
      for (const r of rows) {
        const asset = r.finding?.asset;
        if (!asset) continue;
        const name = `${asset.host}:${asset.port}/${asset.protocol}`;
        countByName.set(name, (countByName.get(name) ?? 0) + 1);
      }

      // Order: count desc, then name asc as the tiebreak so two equal-
      // count assets surface in a stable, alphabetical order. Slice to
      // the caller-supplied `limit`.
      const sorted = Array.from(countByName.entries())
        .sort(([aName, aCount], [bName, bCount]) => {
          if (aCount !== bCount) return bCount - aCount;
          return aName.localeCompare(bName);
        })
        .slice(0, limit)
        .map(([name, count]) => ({ name, count }));

      return NextResponse.json(AssetFilterOptions.parse({ items: sorted }));
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
