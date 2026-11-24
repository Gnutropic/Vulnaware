// @polsia:user-owned — /api/gcp/connections (list / create). Owner-scoped
// via requireAuth(); every query is filtered by user.id so an attacker
// cannot read or mutate foreign connections.

import 'server-only';
import { NextResponse } from 'next/server';
import { GcpConnectionCreate, GcpConnectionItem, GcpConnectionList } from '@/lib/contracts/gcp';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(_req);
  } catch (res) {
    return res as Response;
  }

  try {
    const rows = await prisma.gcpConnection.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const items = GcpConnectionList.parse({
      items: rows.map((r) =>
        GcpConnectionItem.parse({
          id: r.id,
          userId: r.userId,
          label: r.label,
          projectId: r.projectId,
          zones: r.zones,
          createdAt: r.createdAt.toISOString(),
          lastTestedAt: r.lastTestedAt ? r.lastTestedAt.toISOString() : null,
        }),
      ),
    });
    return NextResponse.json(items);
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

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
    return NextResponse.json(
      { errors: { _: 'Request body must be valid JSON.' } },
      { status: 400 },
    );
  }
  const parsed = GcpConnectionCreate.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  try {
    const created = await prisma.gcpConnection.create({
      data: {
        userId: user.id,
        projectId: parsed.data.projectId,
        serviceAccountJson: parsed.data.serviceAccountJson,
        label: parsed.data.label,
        zones: parsed.data.zones,
      },
    });
    const item = GcpConnectionItem.parse({
      id: created.id,
      userId: created.userId,
      label: created.label,
      projectId: created.projectId,
      zones: created.zones,
      createdAt: created.createdAt.toISOString(),
      lastTestedAt: created.lastTestedAt ? created.lastTestedAt.toISOString() : null,
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
