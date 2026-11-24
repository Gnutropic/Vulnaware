// @polsia:user-owned — One-shot endpoint that binds the owner-admin to the
// `system` team so legacy scans created before this revision become accessible
// without a redeploy.
//
// Access: requires the signed-in user to have User.role === 'admin' (the
// owner-admin gate from the framework). Call after deploy to claim legacy
// data — idempotent (safe to repeat). Admin enforcement is inline (rather
// than requireAdmin) because requireAdmin() redirects, and an API endpoint
// must return JSON status codes instead.

import 'server-only';
import { headers as nextHeaders } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { attachSystemTeamIfMissing } from '@/lib/business/api-keys';
import { BootstrapOwnerResponse } from '@/lib/contracts/team';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await auth.api.getSession({ headers: await nextHeaders() });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await attachSystemTeamIfMissing();

  const existingMembership = await prisma.membership.findUnique({
    where: { userId: session.user.id },
  });
  if (existingMembership) {
    return NextResponse.json(
      BootstrapOwnerResponse.parse({ ok: true, teamId: existingMembership.teamId }),
    );
  }

  const system = await prisma.team.findUnique({ where: { name: 'system' } });
  if (!system) {
    return NextResponse.json(
      { error: 'System team not seeded. Verify VULN_API_KEY is configured.' },
      { status: 412 },
    );
  }

  await prisma.membership.create({
    data: { userId: session.user.id, teamId: system.id, role: 'admin' },
  });

  return NextResponse.json(BootstrapOwnerResponse.parse({ ok: true, teamId: system.id }), {
    status: 201,
  });
}
