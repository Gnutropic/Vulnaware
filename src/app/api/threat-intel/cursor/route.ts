// @polsia:user-owned — Read-only health surface for the live threat-intel
// feeds. Returns the latest IntelFeedCursor row per feed so the UI can
// surface "last fetch failed" without grep'ing worker logs. Intel is global
// (CVE keyspace is not per-team), but auth is still required so we never
// leak the cursor state to anonymous traffic.
//
// GET /api/threat-intel/cursor — response: { cursors: [{ feed, lastFetchedAt, lastSuccessAt, lastError, lastErrorAt, itemsSeen }] }

import 'server-only';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireTeamRead } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireTeamRead();
    const cursors = await prisma.intelFeedCursor.findMany({
      orderBy: { feed: 'asc' },
      select: {
        feed: true,
        lastFetchedAt: true,
        lastSuccessAt: true,
        lastError: true,
        lastErrorAt: true,
        itemsSeen: true,
      },
    });
    return NextResponse.json({ cursors });
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
