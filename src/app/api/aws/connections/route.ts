// @polsia:user-owned — /api/aws/connections (list / create). Owner-scoped via
// requireAuth(); every query is filtered by user.id so an attacker cannot
// read or mutate foreign connections.

import 'server-only';
import { NextResponse } from 'next/server';
import { AwsConnectionCreate, AwsConnectionItem, AwsConnectionList } from '@/lib/contracts/aws';
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
    const rows = await prisma.awsConnection.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const items = AwsConnectionList.parse({
      items: rows.map((r) =>
        AwsConnectionItem.parse({
          id: r.id,
          userId: r.userId,
          label: r.label,
          roleArn: r.roleArn,
          regions: r.regions,
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
  const parsed = AwsConnectionCreate.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  try {
    const created = await prisma.awsConnection.create({
      data: {
        userId: user.id,
        roleArn: parsed.data.roleArn,
        externalId: parsed.data.externalId,
        label: parsed.data.label,
        regions: parsed.data.regions,
      },
    });
    const item = AwsConnectionItem.parse({
      id: created.id,
      userId: created.userId,
      label: created.label,
      roleArn: created.roleArn,
      regions: created.regions,
      createdAt: created.createdAt.toISOString(),
      lastTestedAt: created.lastTestedAt ? created.lastTestedAt.toISOString() : null,
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
