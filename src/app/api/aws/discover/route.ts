// @polsia:user-owned — POST /api/aws/discover. Creates a queued AwsDiscoveryRun
// row for the caller's connection; the cron in polsia.toml picks it up and
// runs the orchestrator. We deliberately do NOT call the orchestrator inline
// here — runs can be many minutes, and the deploy is stateless.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AwsDiscoveryCreateResponse, AwsRunStatus } from '@/lib/contracts/aws';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const Body = z.object({
  connectionId: z.string().min(1),
  regions: z
    .array(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/u))
    .max(20)
    .optional(),
});

export async function POST(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ errors: { _: 'Invalid JSON' } }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  const conn = await prisma.awsConnection.findFirst({
    where: { id: parsed.data.connectionId, userId: user.id },
    select: { id: true, regions: true },
  });
  if (!conn) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const regions = parsed.data.regions ?? conn.regions;
    const created = await prisma.awsDiscoveryRun.create({
      data: {
        userId: user.id,
        connectionId: conn.id,
        status: AwsRunStatus.enum.queued,
        regions,
      },
    });
    const body = AwsDiscoveryCreateResponse.parse({
      id: created.id,
      status: AwsRunStatus.enum.queued,
      pollUrl: `/api/aws/discover/${created.id}`,
    });
    return NextResponse.json(body, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
