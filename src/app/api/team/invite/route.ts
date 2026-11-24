// @polsia:user-owned — Invite-a-new-team-member via WorkspaceMember.
//
// POST /api/team/invite
// Admin-gated per-team (requireTeamRole('admin')). Validates email + TTL
// against the zod contract in @/lib/contracts/workspace-member, then:
//
//   1. Mints an invite token + SHA-256 hash (shared helper).
//   2. Upserts WorkspaceMember(row status='invited') for this team/email.
//      - if status='active' → 409 already a member.
//      - if status='invited' → update invitedBy in place; refresh Invite tokens.
//      - else → create both rows fresh.
//   3. Fires teamInviteEmail via the @polsia email proxy using fromFor('invites').
//   4. Audit 'workspace_member.invite'.
//
// Token state still lives on the legacy `Invite` table — the public accept
// flow at /invite/[token] looks the row up by tokenHash from there. The
// WorkspaceMember row is the canonical roster entry (status='invited' until
// accept flips it to 'active').

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import {
  WorkspaceMemberInviteCreate,
  WorkspaceMemberInviteItem,
} from '@/lib/contracts/workspace-member';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { teamInviteEmail } from '@/lib/email/templates';
import { env } from '@/lib/env';
import { mintInviteToken } from '@/lib/invite-token';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const ctx = await requireTeamRole('admin');

    const inviterUserId = ctx.user.id;
    if (!inviterUserId) {
      return NextResponse.json({ errors: { _: 'Authenticated user has no id.' } }, { status: 401 });
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

    const parsed = WorkspaceMemberInviteCreate.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) errors._ = 'Invalid invite.';
      return NextResponse.json({ errors }, { status: 400 });
    }

    const { email, ttlSeconds } = parsed.data;
    const { token, tokenHash } = mintInviteToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const teamId = ctx.membership.teamId;

    // Look up the canonical WorkspaceMember row (active or pending). If
    // 'active' → surface a 409 so the admin uses the assign form instead.
    const existingWm = await prisma.workspaceMember.findUnique({
      where: { workspaceId_email: { workspaceId: teamId, email } },
    });

    if (existingWm && existingWm.status === 'active') {
      return NextResponse.json(
        { errors: { email: 'That person is already a member of this workspace.' } },
        { status: 409 },
      );
    }

    // Same try/catch posture as the legacy /api/team/memberships/invite — the
    // existing pending Invite (if any) is the source of token state, so we
    // refresh it in place rather than spawning a second pending row.
    const existingInvite = await prisma.invite.findFirst({
      where: { teamId, email, acceptedAt: null },
      select: { id: true, createdAt: true },
    });

    const now = new Date();
    const wm = existingWm
      ? await prisma.workspaceMember.update({
          where: {
            workspaceId_email: { workspaceId: teamId, email },
          },
          data: { invitedByUserId: inviterUserId, invitedAt: now },
        })
      : await prisma.workspaceMember.create({
          data: {
            workspaceId: teamId,
            email,
            role: 'member',
            status: 'invited',
            invitedByUserId: inviterUserId,
            invitedAt: now,
          },
        });

    if (existingInvite) {
      await prisma.invite.update({
        where: { id: existingInvite.id },
        data: { tokenHash, expiresAt, invitedByUserId: inviterUserId },
      });
    } else {
      // If a previous invite already saw acceptedAt set, the unique constraint
      // blocks a clean insert. Drop it first — analogous to the legacy
      // invite's refresh-in-place posture.
      await prisma.invite.deleteMany({ where: { teamId, email } });
      await prisma.invite.create({
        data: {
          teamId,
          email,
          tokenHash,
          expiresAt,
          invitedByUserId: inviterUserId,
        },
      });
    }

    const base = env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const inviteUrl = `${base.replace(/\/+$/, '')}/invite/${token}`;

    const tpl = teamInviteEmail({
      orgName: ctx.team.name ?? 'Your team',
      inviterEmail: ctx.user.email,
      inviteUrl,
    });

    void fromFor('invites');

    await sendEmail({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });

    void audit({
      actorUserId: inviterUserId,
      actorTeamId: teamId,
      action: 'workspace_member.invite',
      resourceType: 'workspace_member',
      resourceId: wm.id,
      metadata: { email, ttlSeconds, refresh: Boolean(existingWm) },
      ipAddress: extractIp(req),
    });

    return NextResponse.json(
      WorkspaceMemberInviteItem.parse({
        id: wm.id,
        email,
        workspaceId: teamId,
        role: 'member',
        status: 'invited',
        invitedAt: wm.invitedAt.toISOString(),
        createdAt: wm.createdAt.toISOString(),
      }),
      { status: 201 },
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
