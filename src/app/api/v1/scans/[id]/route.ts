// @polsia:user-owned — v1 enterprise REST: GET /api/v1/scans/:id.
// Auth-gated DB-backed scoped API key endpoint. Returns the compact scan
// header for a single scan owned by the bearing key's team. Team-scope keys
// see any scan owned by their team; scan-scope keys see only the scan matching
// the key's scanId. Foreign-team → 403 forbidden_other_team; wrong scan-scope
// → 403 forbidden_other_scan. Existence never leaked once authenticated.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-auth';
import { EnterpriseScanHeader } from '@/lib/contracts/scan-api';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const IdParam = z
  .string()
  .min(1, 'id required')
  .max(64, 'id too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid id format');

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
          },
        });

        if (!scan) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 });
        }

        if (scan.teamId !== auth.teamId) {
          return NextResponse.json({ error: 'forbidden_other_team' }, { status: 403 });
        }
        if (auth.scopeKind === 'scan' && auth.scanId !== scan.id) {
          return NextResponse.json({ error: 'forbidden_other_scan' }, { status: 403 });
        }

        const body = EnterpriseScanHeader.parse({
          id: scan.id,
          target: scan.target,
          mode: scan.mode,
          status: scan.status,
          startedAt: scan.startedAt.toISOString(),
          finishedAt: scan.finishedAt ? scan.finishedAt.toISOString() : null,
          teamId: scan.teamId,
          source: scan.source,
        });

        return NextResponse.json(body);
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
