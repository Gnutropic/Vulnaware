// @polsia:user-owned — POST /api/gcp/discover. Creates a queued
// GcpDiscoveryRun for the caller's connection. The cron in polsia.toml
// picks it up and runs the orchestrator. Runs are NOT done inline.

import 'server-only';
import { NextResponse } from 'next/server';
import { GcpDiscoveryCreateResponse, GcpRunStatus } from '@/lib/contracts/gcp';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

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
  const body = raw as { connectionId?: string; zones?: unknown };

  if (!body.connectionId || typeof body.connectionId !== 'string') {
    return NextResponse.json({ errors: { connectionId: 'required' } }, { status: 400 });
  }

  const conn = await prisma.gcpConnection.findFirst({
    where: { id: body.connectionId, userId: user.id },
    select: { id: true, zones: true },
  });
  if (!conn) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const zones = Array.isArray(body.zones)
      ? body.zones.filter((z): z is string => typeof z === 'string')
      : conn.zones;
    const created = await prisma.gcpDiscoveryRun.create({
      data: {
        userId: user.id,
        connectionId: conn.id,
        status: GcpRunStatus.enum.queued,
        zones,
      },
    });
    const item = GcpDiscoveryCreateResponse.parse({
      id: created.id,
      status: GcpRunStatus.enum.queued,
      pollUrl: `/api/gcp/discover/${created.id}`,
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
