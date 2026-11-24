// @polsia:user-owned — Asset Discovery & CVE Detection Engine. Scan CRUD.
// GET lists the last 50 scans; POST validates input, runs probes synchronously
// under an 8s aggregate budget, persists assets + findings, returns the
// persisted ScanItem. The only modules that touch @/lib/db + outbound NVD/OSV
// HTTP live behind this surface.

import 'server-only';
import { NextResponse } from 'next/server';
import { recordTrialFunnelStep } from '@/lib/business/analytics';
import { compareFindings } from '@/lib/business/scanner/prioritize';
import { runScan, UnsafeScanTargetError } from '@/lib/business/scanner/run-scan';
import {
  ScanCreate,
  ScanItem as ScanItemSchema,
  ScanList as ScanListSchema,
} from '@/lib/contracts/scan';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { requireTeamRead, requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

const LIST_LIMIT = 50;

export async function GET() {
  try {
    const ctx = await requireTeamRead();
    const scans = await prisma.scan.findMany({
      where: { teamId: ctx.membership.teamId },
      orderBy: { startedAt: 'desc' },
      take: LIST_LIMIT,
      include: {
        assets: true,
        findings: true,
      },
    });

    // Look up CVSS scores from the CveEntry cache so GET-sort can use them
    // as a tiebreaker. Best-effort: missing cache entries fall back to 0.
    const allCveIds = Array.from(new Set(scans.flatMap((s) => s.findings.map((f) => f.cveId))));
    const cveEntries =
      allCveIds.length === 0
        ? []
        : await prisma.cveEntry.findMany({
            where: { cveId: { in: allCveIds } },
            select: { cveId: true, cvssScore: true },
          });
    const cvssByCve = new Map(cveEntries.map((e) => [e.cveId, e.cvssScore]));

    // Per-scan KEV count for the list badge. Single batched query over all
    // listed scans — cheaper than per-scan aggregates.
    const scanIds = scans.map((s) => s.id);
    const kevRows =
      scanIds.length === 0
        ? []
        : await prisma.vulnerabilityFinding.findMany({
            where: { scanId: { in: scanIds }, kevListed: true },
            select: { scanId: true },
          });
    const kevCountByScan = new Map<string, number>();
    for (const row of kevRows) {
      kevCountByScan.set(row.scanId, (kevCountByScan.get(row.scanId) ?? 0) + 1);
    }

    const items = scans.map((scan) =>
      ScanItemSchema.parse({
        id: scan.id,
        target: scan.target,
        mode: scan.mode,
        status: scan.status,
        startedAt: scan.startedAt.toISOString(),
        finishedAt: scan.finishedAt ? scan.finishedAt.toISOString() : null,
        source: scan.source,
        assets: scan.assets.map((a) => ({
          id: a.id,
          host: a.host,
          ip: a.ip,
          port: a.port,
          protocol: a.protocol,
          state: a.state,
          latencyMs: a.latencyMs,
          serviceHint: a.serviceHint,
          banner: a.banner,
        })),
        findings: scan.findings
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
              vulncheckObservedAt: f.vulncheckObservedAt
                ? f.vulncheckObservedAt.toISOString()
                : null,
              lastRescoreAt: f.lastRescoreAt ? f.lastRescoreAt.toISOString() : null,
              rescoreSource: f.rescoreSource ?? null,
              kevListedAt: f.kevListedAt ? f.kevListedAt.toISOString() : null,
            },
          }))
          .sort(compareFindings)
          .map((f) => f.raw),
        kevListedCount: kevCountByScan.get(scan.id) ?? 0,
      }),
    );

    return NextResponse.json(ScanListSchema.parse({ items }));
  } catch (res) {
    // requireTeamRead throws a Response on rejection; route-handler errors
    // raise ordinary exceptions — fall back to 500 for the latter.
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireTeamRole('member');

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = ScanCreate.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) {
        errors._ = 'Invalid scan request';
      }
      return NextResponse.json({ errors }, { status: 400 });
    }

    // Trial-funnel step 3 (first_scan_triggered). The trial-seed writes a
    // sample scan row with the (TRIAL_SAMPLE_TARGET_HOST, tcp-only)
    // fingerprint, so we exclude that exact fingerprint from the count or
    // the gate would never fire for a trial team. Fire-and-forget happens
    // on the success path so a scanner failure still routes through the
    // existing 502 mapper unchanged.
    const beforeCount = await prisma.scan.count({
      where: {
        teamId: ctx.membership.teamId,
        NOT: { target: env.TRIAL_SAMPLE_TARGET_HOST, mode: 'tcp-only' },
      },
    });

    const result = await runScan(parsed.data, {
      teamId: ctx.membership.teamId,
      source: 'manual',
    });

    if (beforeCount === 0) {
      void recordTrialFunnelStep({
        step: 'first_scan_triggered',
        userId: ctx.user.id,
        teamId: ctx.membership.teamId,
      }).catch(() => undefined);
    }

    return NextResponse.json(result, { status: 201 });
  } catch (res) {
    if (res instanceof Response) return res;
    if (res instanceof UnsafeScanTargetError) {
      return NextResponse.json({ errors: { target: res.message } }, { status: 400 });
    }
    // Operational failures (DNS, probe errors, NVD unreachable) all surface
    // as 502 — the scan did not complete; the caller's toast should retry.
    return NextResponse.json({ error: 'scan_failed' }, { status: 502 });
  }
}
