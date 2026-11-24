// @polsia:user-owned — Per-vulnerability remediation report for a completed
// scan. Joins Scan -> Asset + VulnerabilityFinding + CveEntry, groups findings
// by cveId, attaches the matched-asset slice per group, sorts via the shared
// compareFindings comparator (priority desc -> cvss desc -> severity rank desc
// -> cveId asc), and looks up curated remediation guidance from
// cve-remediation.ts (generic fallback for unknown CVEs). Returns a parsed
// ReportItem envelope — page renders from that single fetch.

import 'server-only';
import { NextResponse } from 'next/server';
import { lookupRemediation } from '@/lib/business/scanner/cve-remediation';
import { compareFindings } from '@/lib/business/scanner/prioritize';
import {
  ReportCveGroup,
  type ReportCveGroup as ReportCveGroupT,
  ReportItem,
  ReportMatchedAsset,
  ReportScanHeader,
} from '@/lib/contracts/scan';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const scan = await prisma.scan.findUnique({
      where: { id },
      select: {
        id: true,
        target: true,
        mode: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        source: true,
        assets: {
          select: {
            id: true,
            host: true,
            ip: true,
            port: true,
            serviceHint: true,
            banner: true,
          },
        },
        findings: true,
      },
    });
    if (!scan) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const cveIds = Array.from(new Set(scan.findings.map((f) => f.cveId)));
    const cveEntries =
      cveIds.length === 0
        ? []
        : await prisma.cveEntry.findMany({
            where: { cveId: { in: cveIds } },
            select: { cveId: true, cvssScore: true, description: true, severity: true },
          });
    const cveEntryByCve = new Map(cveEntries.map((e) => [e.cveId, e]));

    const assetsById = new Map(scan.assets.map((a) => [a.id, a]));

    // Sort findings with the shared comparator first, then group adjacent
    // same-cveId entries into ReportCveGroup records. This way the "top"
    // cveId is the first member of each group — the group order is stable
    // and matches the per-asset findings list.
    type SortableFinding = {
      cveId: string;
      severity: string | null;
      cvssScore: number | null;
      priorityScore: number | null;
      epssScore: number | null;
      epssPercentile: number | null;
      kevListed: boolean;
      vulncheckListed: boolean;
      kevListedAt: Date | null;
      assetId: string;
      matchReason: string;
    };

    const cveScore = (cveId: string): number | null => cveEntryByCve.get(cveId)?.cvssScore ?? null;

    const sortedFindings = [...scan.findings]
      .map<SortableFinding>((f) => ({
        cveId: f.cveId,
        severity: f.severity,
        cvssScore: cveScore(f.cveId),
        priorityScore: f.priorityScore,
        epssScore: f.epssScore,
        epssPercentile: f.epssPercentile,
        kevListed: f.kevListed,
        vulncheckListed: f.vulncheckListed,
        kevListedAt: f.kevListedAt,
        assetId: f.assetId,
        matchReason: f.matchReason,
      }))
      .sort((a, b) =>
        compareFindings(
          {
            priorityScore: a.priorityScore,
            severity: a.severity,
            cvssScore: a.cvssScore,
            cveId: a.cveId,
            kevListed: a.kevListed,
            vulncheckListed: a.vulncheckListed,
          },
          {
            priorityScore: b.priorityScore,
            severity: b.severity,
            cvssScore: b.cvssScore,
            cveId: b.cveId,
            kevListed: b.kevListed,
            vulncheckListed: b.vulncheckListed,
          },
        ),
      );

    // Group findings by cveId preserving the comparator order inside each group.
    const groups: SortableFinding[][] = [];
    const groupIndex = new Map<string, number>();
    for (const f of sortedFindings) {
      const existing = groupIndex.get(f.cveId);
      if (existing == null) {
        groupIndex.set(f.cveId, groups.length);
        groups.push([f]);
      } else {
        groups[existing]?.push(f);
      }
    }

    const cveGroups: ReportCveGroupT[] = groups.map((group) => {
      const top = group[0];
      if (!top) {
        // unreachable: groups are only appended in the loop above with at least one entry.
        throw new Error('empty cve group after sort');
      }
      const entry = cveEntryByCve.get(top.cveId);
      const summary =
        entry?.description && entry.description.length > 0 ? entry.description : top.matchReason;

      // Stable, deduped list of matched assets for this CVE.
      const seenAssetIds = new Set<string>();
      const matchedAssetsRaw = group
        .map((f) => assetsById.get(f.assetId))
        .filter((a): a is NonNullable<typeof a> => a != null)
        .sort((a, b) => {
          if (a.port !== b.port) return a.port - b.port;
          return a.host.localeCompare(b.host);
        });
      const matchedAssets = matchedAssetsRaw.flatMap((a) => {
        if (seenAssetIds.has(a.id)) return [];
        seenAssetIds.add(a.id);
        return [
          ReportMatchedAsset.parse({
            id: a.id,
            host: a.host,
            ip: a.ip,
            port: a.port,
            serviceHint: a.serviceHint,
            banner: a.banner,
          }),
        ];
      });

      const remediation = lookupRemediation(top.cveId);
      return ReportCveGroup.parse({
        cveId: top.cveId,
        severity: top.severity,
        cvssScore: top.cvssScore,
        epssScore: top.epssScore,
        epssPercentile: top.epssPercentile,
        priorityScore: top.priorityScore,
        kevListed: top.kevListed,
        dateAdded: top.kevListedAt ? top.kevListedAt.toISOString().slice(0, 10) : null,
        summary,
        matchedAssets,
        recommendedFix: remediation.recommendedFix,
        fixVersionOrPatch: remediation.fixVersionOrPatch,
        verificationStep: remediation.verificationStep,
        references: remediation.references,
      });
    });

    const item = ReportItem.parse({
      scan: ReportScanHeader.parse({
        id: scan.id,
        target: scan.target,
        mode: scan.mode,
        status: scan.status,
        startedAt: scan.startedAt.toISOString(),
        finishedAt: scan.finishedAt ? scan.finishedAt.toISOString() : null,
        source: scan.source,
      }),
      cveGroups,
    });

    return NextResponse.json(item);
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
