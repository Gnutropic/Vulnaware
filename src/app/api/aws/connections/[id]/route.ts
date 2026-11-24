// @polsia:user-owned — /api/aws/connections/[id] (PATCH / DELETE).
// Owner-scoped update/delete — never touch a connection that isn't the
// caller's.

import 'server-only';
import { NextResponse } from 'next/server';
import { AwsConnectionItem, AwsConnectionPatch } from '@/lib/contracts/aws';
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
  const parsed = AwsConnectionPatch.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  try {
    // updateMany with the userId in the WHERE so cross-user writes can never
    // mutate a foreign row — count returns 0 if it didn't match.
    const result = await prisma.awsConnection.updateMany({
      where: { id, userId: user.id },
      data: {
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.regions ? { regions: parsed.data.regions } : {}),
      },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const row = await prisma.awsConnection.findFirst({ where: { id, userId: user.id } });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const item = AwsConnectionItem.parse({
      id: row.id,
      userId: row.userId,
      label: row.label,
      roleArn: row.roleArn,
      regions: row.regions,
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
    const result = await prisma.awsConnection.deleteMany({
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
