// @polsia:user-owned — single-scan fetch by id. Used by /scans/[id] page.

import 'server-only';
import { NextResponse } from 'next/server';
import { compareFindings } from '@/lib/business/scanner/prioritize';
import { ScanItem as ScanItemSchema } from '@/lib/contracts/scan';
import { prisma } from '@/lib/db';
import { requireTeamRead } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireTeamRead();
    const { id } = await params;

    const scan = await prisma.scan.findUnique({
      where: { id },
      include: { assets: true, findings: true },
    });
    // Never 404 after auth — that leaks existence. A genuine 404 is the same
    // opaque "not yours" answer as a cross-team id: the caller has no way to
    // distinguish "no such scan" from "wrong team".
    if (!scan || scan.teamId !== ctx.membership.teamId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Look up CVSS scores for findings so the GET-sort tiebreaker is stable.
    const cveIds = Array.from(new Set(scan.findings.map((f) => f.cveId)));
    const cveEntries =
      cveIds.length === 0
        ? []
        : await prisma.cveEntry.findMany({
            where: { cveId: { in: cveIds } },
            select: { cveId: true, cvssScore: true },
          });
    const cvssByCve = new Map(cveEntries.map((e) => [e.cveId, e.cvssScore]));

    const orderedFindings = scan.findings
      .map((f) => ({
        priorityScore: f.priorityScore,
        severity: f.severity,
        cvssScore: cvssByCve.get(f.cveId) ?? null,
        cveId: f.cveId,
        kevListed: f.kevListed,
        vulncheckListed: f.vulncheckListed,
        raw: {
          id: f.id,
          assetId: f.assetId,
          cveId: f.cveId,
          severity: f.severity,
          matchReason: f.matchReason,
          priorityScore: f.priorityScore,
          epssScore: f.epssScore,
          epssPercentile: f.epssPercentile,
          kevListed: f.kevListed,
          vulncheckListed: f.vulncheckListed,
          vulncheckObservedAt: f.vulncheckObservedAt ? f.vulncheckObservedAt.toISOString() : null,
          lastRescoreAt: f.lastRescoreAt ? f.lastRescoreAt.toISOString() : null,
          rescoreSource: f.rescoreSource ?? null,
          kevListedAt: f.kevListedAt ? f.kevListedAt.toISOString() : null,
        },
      }))
      .sort(compareFindings)
      .map((f) => f.raw);

    const item = ScanItemSchema.parse({
      id: scan.id,
      target: scan.target,
      mode: scan.mode,
      status: scan.status,
      startedAt: scan.startedAt.toISOString(),
      finishedAt: scan.finishedAt ? scan.finishedAt.toISOString() : null,
      assets: scan.assets.map((a) => ({
        id: a.id,
        host: a.host,
        ip: a.ip,
        port: a.port,
        protocol: a.protocol,
        state: a.state as 'up' | 'down' | 'filtered',
        latencyMs: a.latencyMs,
        serviceHint: a.serviceHint,
        banner: a.banner,
      })),
      findings: orderedFindings,
      source: scan.source,
    });
    return NextResponse.json(item);
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
