// @polsia:user-owned — v1 enterprise REST: GET /api/v1/scans/:id/findings.
// Auth-gated DB-backed scoped API key endpoint. Team-scope keys see findings
// for any scan owned by their team; scan-scope keys see findings only when
// the requested id matches the key's scanId. Foreign-team emits 403
// (`forbidden_other_team`); wrong scanId emits 403 (`forbidden_other_scan`).
// Existence is never leaked (always 403, never 404) once the key is
// authenticated but unauthorized.
//
// Loads the scan + its assets + findings in one Prisma round-trip, batch-
// loads CveEntry cache rows for CVSS, joins the matched Asset inline per
// finding, sorts via the shared compareFindings comparator (priority desc ->
// cvss desc -> severity rank desc -> cveId asc), and emits deterministic
// remediation strings from lookupRemediation. Slices AFTER sort so
// pagination is stable across requests.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-auth';
import { lookupRemediation } from '@/lib/business/scanner/cve-remediation';
import { compareFindings } from '@/lib/business/scanner/prioritize';
import {
  EnterpriseFinding,
  EnterpriseMatchedAsset,
  EnterpriseScanFindingsResponse,
  EnterpriseScanHeader,
} from '@/lib/contracts/scan-api';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const IdParam = z
  .string()
  .min(1, 'id required')
  .max(64, 'id too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid id format');

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const auth = await verifyApiKey(req);
      if (auth instanceof NextResponse) return auth;

      setRequestAuth({
        teamId: auth.teamId,
        keyId: auth.keyId,
        scopeKind: auth.scopeKind,
      });

      const { id } = await params;
      const idCheck = IdParam.safeParse(id);
      if (!idCheck.success) {
        return NextResponse.json(
          { error: 'bad_request', reason: 'invalid id format' },
          { status: 400 },
        );
      }

      const url = new URL(req.url);
      const queryCheck = Query.safeParse({
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      if (!queryCheck.success) {
        return NextResponse.json(
          { error: 'bad_request', reason: 'invalid query' },
          { status: 400 },
        );
      }
      const { limit, offset } = queryCheck.data;

      try {
        const scan = await prisma.scan.findUnique({
          where: { id: idCheck.data },
          select: {
            id: true,
            target: true,
            mode: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            teamId: true,
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

        // Access control — applies BEFORE building findings. Foreign-team and
        // wrong-scan emit 403 (not 404) so an authenticated-but-unauthorized
        // caller cannot probe for scan existence.
        if (scan.teamId !== auth.teamId) {
          return NextResponse.json({ error: 'forbidden_other_team' }, { status: 403 });
        }
        if (auth.scopeKind === 'scan' && auth.scanId !== scan.id) {
          return NextResponse.json({ error: 'forbidden_other_scan' }, { status: 403 });
        }

        const cveIds = Array.from(new Set(scan.findings.map((f) => f.cveId)));
        const cveEntries =
          cveIds.length === 0
            ? []
            : await prisma.cveEntry.findMany({
                where: { cveId: { in: cveIds } },
                select: { cveId: true, cvssScore: true },
              });
        const cvssByCve = new Map(cveEntries.map((e) => [e.cveId, e.cvssScore]));
        const assetsById = new Map(scan.assets.map((a) => [a.id, a]));

        const findings = scan.findings
          .map((f) => {
            const asset = assetsById.get(f.assetId);
            if (!asset) {
              return null;
            }
            const cvssScore = cvssByCve.get(f.cveId) ?? null;
            const remediation = lookupRemediation(f.cveId);
            return {
              sortKey: {
                priorityScore: f.priorityScore,
                severity: f.severity,
                cvssScore,
                cveId: f.cveId,
                kevListed: f.kevListed,
                vulncheckListed: f.vulncheckListed,
              },
              item: EnterpriseFinding.parse({
                cveId: f.cveId,
                severity: f.severity,
                cvssScore,
                epssScore: f.epssScore,
                epssPercentile: f.epssPercentile,
                priorityScore: f.priorityScore,
                kevListed: f.kevListed,
                kevListedAt: f.kevListedAt ? f.kevListedAt.toISOString() : null,
                vulncheckListed: f.vulncheckListed,
                vulncheckObservedAt: f.vulncheckObservedAt
                  ? f.vulncheckObservedAt.toISOString()
                  : null,
                lastRescoreAt: f.lastRescoreAt ? f.lastRescoreAt.toISOString() : null,
                rescoreSource: f.rescoreSource ?? null,
                matchReason: f.matchReason,
                asset: EnterpriseMatchedAsset.parse({
                  id: asset.id,
                  host: asset.host,
                  ip: asset.ip,
                  port: asset.port,
                  serviceHint: asset.serviceHint,
                  banner: asset.banner,
                }),
                remediation,
              }),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
          .sort((a, b) => compareFindings(a.sortKey, b.sortKey))
          .map((x) => x.item);

        const total = findings.length;
        const page = findings.slice(offset, offset + limit);

        const body = EnterpriseScanFindingsResponse.parse({
          scan: EnterpriseScanHeader.parse({
            id: scan.id,
            target: scan.target,
            mode: scan.mode,
            status: scan.status,
            startedAt: scan.startedAt.toISOString(),
            finishedAt: scan.finishedAt ? scan.finishedAt.toISOString() : null,
            teamId: scan.teamId,
            source: scan.source,
          }),
          findings: page,
          limit,
          offset,
          total,
        });

        return NextResponse.json(body);
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}
