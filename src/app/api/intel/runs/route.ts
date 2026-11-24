// @polsia:user-owned — Team-scoped read API for the competitive-intel
// audit feed. Mirrors src/app/api/alerts/route.ts posture,
// gap-trimmed: no POST, no query-string filters — the listing is the
// autocompiled newest-first slice per team.
//
// Access-control posture:
//   - GET requires `requireTeamRead()` — anonymous callers get 401;
//     signed-in callers without a team get 404.
//   - Every Prisma read is seeded with `teamId: ctx.membership.teamId`
//     so the list is always narrow to the caller's team.

import 'server-only';
import { NextResponse } from 'next/server';
import { IntelRunList, IntelRunListItem } from '@/lib/contracts/intel';
import { prisma } from '@/lib/db';
import { requireTeamRead } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export async function GET() {
  try {
    const ctx = await requireTeamRead();
    const teamId = ctx.membership.teamId;

    const rows = await prisma.competitiveIntelRun.findMany({
      where: { teamId },
      orderBy: { ranAt: 'desc' },
      take: PAGE_SIZE,
      select: { id: true, ranAt: true, headline: true },
    });

    const items = rows.map((r) =>
      IntelRunListItem.parse({
        id: r.id,
        ranAt: r.ranAt.toISOString(),
        headline: r.headline,
      }),
    );

    return NextResponse.json(IntelRunList.parse({ items }));
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
