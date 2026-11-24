// @polsia:user-owned — v1 enterprise REST: GET /api/v1/scans.
// Auth-gated DB-backed scoped API key endpoint. Returns the compact scan
// metadata envelope filtered to scans owned by the bearing key's team. A
// `scan`-scope key cannot list across scans at all (returns 403) — its world
// is just one scan. Sibling surface to the un-authed /api/scan route.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-auth';
import { EnterpriseScanHeader, EnterpriseScanListResponse } from '@/lib/contracts/scan-api';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const auth = await verifyApiKey(req);
      if (auth instanceof NextResponse) return auth;

      setRequestAuth({
        teamId: auth.teamId,
        keyId: auth.keyId,
        scopeKind: auth.scopeKind,
      });

      // scan-scope keys are bounded to a single scan — they cannot list across
      // scans. Return 403 (not 401) so an authenticated-but-unauthorized caller
      // gets a meaningful posture without leaking the list shape.
      if (auth.scopeKind === 'scan') {
        return NextResponse.json(
          { error: 'forbidden_scope', reason: 'scan-scope keys cannot list scans' },
          { status: 403 },
        );
      }

      const url = new URL(req.url);
      const parsed = Query.safeParse({
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'bad_request', reason: 'invalid query' },
          { status: 400 },
        );
      }
      const { limit, offset } = parsed.data;

      try {
        const where = { teamId: auth.teamId };
        const [scans, total] = await Promise.all([
          prisma.scan.findMany({
            where,
            orderBy: { startedAt: 'desc' },
            skip: offset,
            take: limit,
            select: {
              id: true,
              target: true,
              mode: true,
              status: true,
              startedAt: true,
              finishedAt: true,
              source: true,
            },
          }),
          prisma.scan.count({ where }),
        ]);

        const items = EnterpriseScanListResponse.parse({
          items: scans.map((s) =>
            EnterpriseScanHeader.parse({
              id: s.id,
              target: s.target,
              mode: s.mode,
              status: s.status,
              startedAt: s.startedAt.toISOString(),
              finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
              teamId: auth.teamId,
              source: s.source,
            }),
          ),
          limit,
          offset,
          total,
        });

        return NextResponse.json(items);
      } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
      }
    }),
  );
}
