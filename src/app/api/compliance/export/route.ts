// @polsia:user-owned — `/api/compliance/export` streams a styled A4 PDF
// mirroring the on-screen /compliance page for the active framework filter
// (summary, control breakdown, findings audit trail with `tag.reason`). The
// data plane mirrors `/api/compliance` exactly: same Prisma queries, same
// `mapFindingToControls` / `summarizeFrameworks` derivation, and the
// shared `ComplianceList.parse` envelope — so the PDF cannot drift from the
// JSON response shape.
//
// Auth posture: admin (requireTeamRole('admin')) — same as the JSON route.
// The browser triggers a native download via `<a download>`; no client
// fetch is involved.

import 'server-only';
import {
  type FindingInput,
  mapFindingToControls,
  summarizeFrameworks,
} from '@/lib/business/compliance/framework-mapper';
import { renderCompliancePdf } from '@/lib/business/compliance/pdf-render';
import {
  ComplianceFramework,
  ComplianceList,
  type FindingWithControls,
  type FrameworkCoverage,
} from '@/lib/contracts/compliance';
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

      const frameworkParam = new URL(req.url).searchParams.get('framework');
      const requestedFramework: ComplianceFramework =
        ComplianceFramework.safeParse(frameworkParam).data ?? 'SOC2';

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

      const findingRows: FindingWithControls[] = prepared.map((p) => ({
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

      const parsed = ComplianceList.parse({
        frameCount: coverages.length,
        scannedAt: new Date().toISOString(),
        scansAnalyzed: scans.length,
        items: coverages,
        findings: { items: findingRows },
      });

      const coverage: FrameworkCoverage | undefined = parsed.items.find(
        (it) => it.framework === requestedFramework,
      );
      if (!coverage) {
        return new Response(JSON.stringify({ error: 'Framework not in summary' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const relevantFindings = parsed.findings.items.filter((f) =>
        f.tags.some((t) => t.framework === requestedFramework),
      );

      const bytes = renderCompliancePdf({
        teamName: ctx.team.name,
        generatedAt: new Date().toISOString(),
        framework: requestedFramework,
        coverage,
        findings: relevantFindings,
        scansAnalyzed: parsed.scansAnalyzed,
      });

      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `compliance-${requestedFramework.toLowerCase()}-${dateStr}.pdf`;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    } catch (res) {
      if (res instanceof Response) return res;
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  });
}
