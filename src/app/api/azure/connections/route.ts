// @polsia:user-owned — /api/azure/connections (list / create). Owner-scoped
// via requireAuth(); every query is filtered by user.id so an attacker
// cannot read or mutate foreign connections.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  AzureConnectionCreate,
  AzureConnectionItem,
  AzureConnectionList,
} from '@/lib/contracts/azure';
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
    const rows = await prisma.azureConnection.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const items = AzureConnectionList.parse({
      items: rows.map((r) =>
        AzureConnectionItem.parse({
          id: r.id,
          userId: r.userId,
          label: r.label,
          subscriptionId: r.subscriptionId,
          tenantId: r.tenantId,
          clientId: r.clientId,
          locations: r.locations,
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
  const parsed = AzureConnectionCreate.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  try {
    const created = await prisma.azureConnection.create({
      data: {
        userId: user.id,
        subscriptionId: parsed.data.subscriptionId,
        tenantId: parsed.data.tenantId,
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        label: parsed.data.label,
        locations: parsed.data.locations,
      },
    });
    const item = AzureConnectionItem.parse({
      id: created.id,
      userId: created.userId,
      label: created.label,
      subscriptionId: created.subscriptionId,
      tenantId: created.tenantId,
      clientId: created.clientId,
      locations: created.locations,
      createdAt: created.createdAt.toISOString(),
      lastTestedAt: created.lastTestedAt ? created.lastTestedAt.toISOString() : null,
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
