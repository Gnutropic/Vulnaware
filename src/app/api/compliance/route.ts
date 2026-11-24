// @polsia:user-owned — `/api/compliance` aggregates the last 50 scans for the
// caller's team, joins `CveEntry.description` for richer keyword coverage,
// runs the deterministic mapper in src/lib/business/compliance/framework-
// mapper, and returns the shared `ComplianceList` envelope.
//
// Auth posture: admin (requireTeamRole('admin')). Compliance views are
// auditor-facing artifacts; the sidebar entry mirrors the gate. To loosen
// to `member`, change exactly two places: this route and ADMIN_ITEMS →
// PRIMARY_ITEMS in src/components/custom/dashboard/dashboard-nav.tsx.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  type FindingInput,
  mapFindingToControls,
  summarizeFrameworks,
} from '@/lib/business/compliance/framework-mapper';
import { ComplianceList } from '@/lib/contracts/compliance';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

const LIST_LIMIT = 50;

interface FindingMeta {
  scanId: string;
  scanTarget: string;
  scanStartedAt: string;
}

interface PreparedFinding extends FindingInput {
  meta: FindingMeta;
}

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    try {
      const ctx = await requireTeamRole('admin');
      setRequestAuth({ userId: ctx.user.id, teamId: ctx.membership.teamId });

      const scans = await prisma.scan.findMany({
        where: { teamId: ctx.membership.teamId },
        orderBy: { startedAt: 'desc' },
        take: LIST_LIMIT,
        include: { findings: true },
      });

      const allCveIds = Array.from(new Set(scans.flatMap((s) => s.findings.map((f) => f.cveId))));
      const descriptionByCve = new Map<string, string>();
      if (allCveIds.length > 0) {
        const cveEntries = await prisma.cveEntry.findMany({
          where: { cveId: { in: allCveIds } },
          select: { cveId: true, description: true },
        });
        for (const entry of cveEntries) descriptionByCve.set(entry.cveId, entry.description);
      }

      const prepared: PreparedFinding[] = [];
      for (const scan of scans) {
        const meta: FindingMeta = {
          scanId: scan.id,
          scanTarget: scan.target,
          scanStartedAt: scan.startedAt.toISOString(),
        };
        for (const f of scan.findings) {
          prepared.push({
            cveId: f.cveId,
            severity: f.severity,
            matchReason: f.matchReason,
            description: descriptionByCve.get(f.cveId) ?? null,
            meta,
          });
        }
      }

      const inputs: FindingInput[] = prepared.map((p) => ({
        cveId: p.cveId,
        severity: p.severity,
        matchReason: p.matchReason,
        description: p.description,
      }));
      const coverages = summarizeFrameworks(inputs);

      const findingRows = prepared.map((p) => ({
        cveId: p.cveId,
        severity: p.severity,
        matchReason: p.matchReason ?? '',
        scanId: p.meta.scanId,
        scanTarget: p.meta.scanTarget,
        scanStartedAt: p.meta.scanStartedAt,
        tags: mapFindingToControls(p).map((t) => ({
          framework: t.framework,
          controlId: t.controlId,
          reason: t.reason,
        })),
      }));

      const payload = ComplianceList.parse({
        frameCount: coverages.length,
        scannedAt: new Date().toISOString(),
        scansAnalyzed: scans.length,
        items: coverages,
        findings: { items: findingRows },
      });

      return NextResponse.json(payload);
    } catch (res) {
      if (res instanceof Response) return res;
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}
