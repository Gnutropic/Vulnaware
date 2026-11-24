// @polsia:user-owned — On-demand rescoring endpoint. Re-derives KEV/EPSS/
// VulnCheck for a single Scan and applies the new priority formula via
// live-rescore.ts. Team-scoped: re-verifies scan.teamId === ctx.teamId
// defensively even though requireTeamRole gates the caller.
//
// POST /api/scan/[id]/rescore — body ignored, response: { bumped, topFindings, etag }.

import 'server-only';
import { NextResponse } from 'next/server';
import { rescoreScan } from '@/lib/business/scanner/live-rescore';
import { prisma } from '@/lib/db';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireTeamRole('member');
    const { id } = await params;

    // Confirm the scan belongs to this team BEFORE any writes — defensive
    // double-check even though requireTeamRole gates the caller; never let
    // an id from another tenant leak through cross-team references.
    const scan = await prisma.scan.findUnique({
      where: { id },
      select: { id: true, teamId: true },
    });
    if (!scan || scan.teamId !== ctx.membership.teamId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = await rescoreScan(scan.id, { trigger: 'manual' });

    return NextResponse.json({
      scanId: scan.id,
      scanned: result.scanned,
      bumped: result.bumped,
      vulncheckSightings: result.vulncheckSightings,
      topFindings: result.top,
    });
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
