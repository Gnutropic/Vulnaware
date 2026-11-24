// @polsia:user-owned — POST /api/azure/discover. Creates a queued
// AzureDiscoveryRun for the caller's connection; the cron in polsia.toml
// picks it up and runs the orchestrator. We deliberately do NOT call the
// orchestrator inline — runs can be many minutes.

import 'server-only';
import { NextResponse } from 'next/server';
import { AzureDiscoveryCreateResponse, AzureRunStatus } from '@/lib/contracts/azure';
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
  const body = raw as { connectionId?: string; locations?: unknown };

  if (!body.connectionId || typeof body.connectionId !== 'string') {
    return NextResponse.json({ errors: { connectionId: 'required' } }, { status: 400 });
  }

  const conn = await prisma.azureConnection.findFirst({
    where: { id: body.connectionId, userId: user.id },
    select: { id: true, locations: true },
  });
  if (!conn) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const locations = Array.isArray(body.locations)
      ? body.locations.filter((loc): loc is string => typeof loc === 'string')
      : conn.locations;
    const created = await prisma.azureDiscoveryRun.create({
      data: {
        userId: user.id,
        connectionId: conn.id,
        status: AzureRunStatus.enum.queued,
        locations,
      },
    });
    const item = AzureDiscoveryCreateResponse.parse({
      id: created.id,
      status: AzureRunStatus.enum.queued,
      pollUrl: `/api/azure/discover/${created.id}`,
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
