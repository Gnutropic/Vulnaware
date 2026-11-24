// @polsia:user-owned — Single competitive-intel run fetch by id. Used
// by /settings/intel's click-to-expand affordance to lazy-load
// `body` (the list keeps body out of the payload to stay trim).
//
// Access-control posture mirrors /api/intel/runs (the list): GET
// requires `requireTeamRead()`; the `findUnique` lookup is seeded
// with the caller's teamId so a cross-team id (or a fully missing
// row) both resolve to the same opaque 404 — there's no
// existence-as-leak vector.

import 'server-only';
import { NextResponse } from 'next/server';
import { IntelRunDetail } from '@/lib/contracts/intel';
import { prisma } from '@/lib/db';
import { requireTeamRead } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireTeamRead();
    const teamId = ctx.membership.teamId;
    const { id } = await params;

    const row = await prisma.competitiveIntelRun.findUnique({
      where: { id },
      select: { id: true, teamId: true, ranAt: true, headline: true, body: true },
    });

    // 404 for BOTH "no row" and "wrong team" — same opaque answer so a
    // caller cannot probe for cross-team ids by status code.
    if (!row || row.teamId !== teamId) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(
      IntelRunDetail.parse({
        id: row.id,
        ranAt: row.ranAt.toISOString(),
        headline: row.headline,
        body: row.body,
      }),
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
