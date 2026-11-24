// @polsia:user-owned — Team roster API.
// GET: any team member can read the roster.
// POST: admin only — assign an existing better-auth user (looked up by email)
//   to the caller's team. No email-invite flow: the user must already have a
//   account. Duplicate assignments are rejected.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { MembershipAssign, MembershipItem, MembershipList } from '@/lib/contracts/team';
import { prisma } from '@/lib/db';
import { requireTeamRead, requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await requireTeamRead();

    const rows = await prisma.membership.findMany({
      where: { teamId: ctx.membership.teamId },
      orderBy: { createdAt: 'asc' },
    });

    // Pending invites from the WorkspaceMember table. Their `userId` is null
    // while invited (no account yet) so no User join is required for them.
    const inviteRows = await prisma.workspaceMember.findMany({
      where: { workspaceId: ctx.membership.teamId, status: 'invited' },
      orderBy: { createdAt: 'asc' },
    });

    // Join in app code — scalar userId FK into the locked User model means
    // there's no include edge. Batch-resolve user rows by id.
    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // Defensive: drop a pending WorkspaceMember whose email already matches
    // an active Membership's email. Avoids surfacing the same email twice
    // during the brief window after accept (the Membership write fires
    // before WorkspaceMember flips to active).
    const activeEmails = Array.from(
      new Set(rows.map((row) => userById.get(row.userId)?.email?.toLowerCase() ?? null)),
    ).filter((e): e is string => !!e);
    const activeEmailSet = new Set(activeEmails);
    const pendingInvites = inviteRows.filter((inv) => !activeEmailSet.has(inv.email.toLowerCase()));

    const items = [
      ...rows.map((row) => {
        const u = userById.get(row.userId);
        const createdAt = row.createdAt.toISOString();
        return MembershipItem.parse({
          id: row.id,
          userId: row.userId,
          email: u?.email ?? null,
          name: u?.name ?? null,
          role: row.role,
          status: 'active',
          invitedAt: null,
          joinedAt: createdAt,
          createdAt,
        });
      }),
      ...pendingInvites.map((inv) =>
        MembershipItem.parse({
          id: inv.id,
          userId: inv.userId ?? null,
          email: inv.email,
          name: null,
          role: inv.role,
          status: 'invited',
          invitedAt: inv.invitedAt.toISOString(),
          joinedAt: null,
          createdAt: inv.createdAt.toISOString(),
        }),
      ),
    ];

    return NextResponse.json(
      MembershipList.parse({
        team: ctx.team,
        items,
      }),
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireTeamRole('admin');

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = MembershipAssign.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) errors._ = 'Invalid assignment.';
      return NextResponse.json({ errors }, { status: 400 });
    }

    const { email, role } = parsed.data;
    const normalized = email.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      return NextResponse.json(
        { errors: { email: 'No account exists for that email.' } },
        { status: 404 },
      );
    }

    const existing = await prisma.membership.findUnique({ where: { userId: user.id } });
    if (existing) {
      if (existing.teamId === ctx.membership.teamId) {
        return NextResponse.json(
          { errors: { email: 'That user is already on this team.' } },
          { status: 409 },
        );
      }
      // Cross-team: we don't auto-reassign. The admin should ask the user to
      // change teams themselves (out of scope for this revision).
      return NextResponse.json(
        { errors: { email: 'That user already belongs to another workspace.' } },
        { status: 409 },
      );
    }

    const created = await prisma.membership.create({
      data: { userId: user.id, teamId: ctx.membership.teamId, role },
    });

    void audit({
      actorUserId: ctx.user.id,
      actorTeamId: ctx.membership.teamId,
      action: 'membership.assign',
      resourceType: 'membership',
      resourceId: created.id,
      metadata: { targetUserId: user.id, email: user.email, role },
      ipAddress: extractIp(req),
    });

    return NextResponse.json(
      MembershipItem.parse({
        id: created.id,
        userId: created.userId,
        email: user.email,
        name: user.name,
        role: created.role,
        status: 'active',
        invitedAt: null,
        joinedAt: created.createdAt.toISOString(),
        createdAt: created.createdAt.toISOString(),
      }),
      { status: 201 },
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
