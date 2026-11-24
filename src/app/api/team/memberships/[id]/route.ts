// @polsia:user-owned — Per-membership edit/delete API.
// PATCH: admin only — change a member's role. Refuses self-demote if the
//   caller is the LAST admin on the team (would orphan the team of
//   admins). Same-team check guards against cross-team edits.
// DELETE: admin only — remove a member. Same last-admin guard.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { MembershipItem, MembershipRoleUpdate } from '@/lib/contracts/team';
import { prisma } from '@/lib/db';
import { type MembershipRow, requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

async function findMyMembershipRow(
  membershipId: string,
  teamId: string,
): Promise<MembershipRow | null> {
  // Same-team guard: cross-team edits return 404, never 403, so a foreign
  // member id is indistinguishable from a missing one.
  const row = await prisma.membership.findFirst({
    where: { id: membershipId, teamId },
    select: { id: true, userId: true, teamId: true, role: true },
  });
  return row;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireTeamRole('admin');
    const { id } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = MembershipRoleUpdate.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ errors: { role: 'A valid role is required.' } }, { status: 400 });
    }

    const target = await findMyMembershipRow(id, ctx.membership.teamId);
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Block the last-admin demotion / deletion. We count admins after the
    // proposed change so the call surface stays in sync with the saved row.
    if (target.role === 'admin' && parsed.data.role !== 'admin') {
      const adminCount = await prisma.membership.count({
        where: { teamId: ctx.membership.teamId, role: 'admin' },
      });
      if (adminCount <= 1) {
        return NextResponse.json({ error: 'Cannot demote the last admin.' }, { status: 409 });
      }
    }

    const updated = await prisma.membership.update({
      where: { id: target.id },
      data: { role: parsed.data.role },
    });

    void audit({
      actorUserId: ctx.user.id,
      actorTeamId: ctx.membership.teamId,
      action: 'membership.role_change',
      resourceType: 'membership',
      resourceId: target.id,
      metadata: { previousRole: target.role, newRole: parsed.data.role },
      ipAddress: extractIp(req),
    });

    const user = await prisma.user.findUnique({
      where: { id: updated.userId },
      select: { email: true, name: true },
    });

    return NextResponse.json(
      MembershipItem.parse({
        id: updated.id,
        userId: updated.userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        role: updated.role,
        status: 'active',
        invitedAt: null,
        joinedAt: updated.createdAt.toISOString(),
        createdAt: updated.createdAt.toISOString(),
      }),
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireTeamRole('admin');
    const { id } = await params;

    const target = await findMyMembershipRow(id, ctx.membership.teamId);
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Same last-admin guard: refuse to delete the last admin.
    if (target.role === 'admin') {
      const adminCount = await prisma.membership.count({
        where: { teamId: ctx.membership.teamId, role: 'admin' },
      });
      if (adminCount <= 1) {
        return NextResponse.json({ error: 'Cannot remove the last admin.' }, { status: 409 });
      }
    }

    await prisma.membership.delete({ where: { id: target.id } });
    void audit({
      actorUserId: ctx.user.id,
      actorTeamId: ctx.membership.teamId,
      action: 'membership.remove',
      resourceType: 'membership',
      resourceId: target.id,
      metadata: { removedUserId: target.userId, role: target.role },
      ipAddress: extractIp(req),
    });
    return NextResponse.json({ ok: true });
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
