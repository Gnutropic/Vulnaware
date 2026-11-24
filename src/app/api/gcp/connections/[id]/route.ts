// @polsia:user-owned — /api/gcp/connections/[id] (PATCH / DELETE).
// Owner-scoped update/delete — never touch a connection that isn't the
// caller's.

import 'server-only';
import { NextResponse } from 'next/server';
import { GcpConnectionItem, GcpConnectionPatch } from '@/lib/contracts/gcp';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ errors: { _: 'Invalid JSON' } }, { status: 400 });
  }
  const parsed = GcpConnectionPatch.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  try {
    const result = await prisma.gcpConnection.updateMany({
      where: { id, userId: user.id },
      data: {
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.zones ? { zones: parsed.data.zones } : {}),
      },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const row = await prisma.gcpConnection.findFirst({ where: { id, userId: user.id } });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const item = GcpConnectionItem.parse({
      id: row.id,
      userId: row.userId,
      label: row.label,
      projectId: row.projectId,
      zones: row.zones,
      createdAt: row.createdAt.toISOString(),
      lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    });
    return NextResponse.json(item);
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { id } = await ctx.params;
  try {
    const result = await prisma.gcpConnection.deleteMany({
      where: { id, userId: user.id },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
