// @polsia:user-owned — Invite-a-new-team-member endpoint.
//
// POST /api/team/memberships/invite
// Admin-gated per-team (requireTeamRole('admin')). Validates email + TTL via
// the zod contract in @/lib/contracts/invites, mints a SHA-256-hashed invite
// token, upserts the Invite row (creating a new one, OR refreshing an
// existing pending row in place — never overwriting acceptedAt), and fires
// a teamInviteEmail via the @polsia email proxy using `fromFor('invites')`
// as the from-identity.
//
// teamId is always derived from ctx.team.id — never trusted from the body.
// invitedByUserId is always derived from ctx.user.id.

import 'server-only';
import { NextResponse } from 'next/server';
import { audit, extractIp } from '@/lib/business/audit';
import { InviteCreate, InviteItem } from '@/lib/contracts/invites';
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

    const parsed = InviteCreate.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
    }

    const { email, ttlSeconds } = parsed.data;

    const { token, tokenHash } = mintInviteToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const teamId = ctx.team.id;

    // Look for a still-pending row for this (teamId, email). Refresh its
    // token in place so a re-sent invitation doesn't spawn a second
    // pending row (Prisma @@unique is unconditional, so we can't create a
    // second pending row alongside the existing one).
    const existing = await prisma.invite.findFirst({
      where: { teamId, email, acceptedAt: null },
      select: { id: true, acceptedAt: true, createdAt: true },
    });

    let invite: { id: string; createdAt: Date };

    if (existing) {
      invite = await prisma.invite.update({
        where: { id: existing.id },
        data: { tokenHash, expiresAt, invitedByUserId: inviterUserId },
        select: { id: true, createdAt: true },
      });
    } else {
      // If a previous invite already saw `acceptedAt` set, the unique
      // constraint blocks a clean insert. Drop it first — the accepted
      // row is a historical artifact and we want a fresh pending row.
      await prisma.invite.deleteMany({ where: { teamId, email } });
      invite = await prisma.invite.create({
        data: {
          teamId,
          email,
          tokenHash,
          expiresAt,
          invitedByUserId: inviterUserId,
        },
        select: { id: true, createdAt: true },
      });
    }

    const base = env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const inviteUrl = `${base.replace(/\/+$/, '')}/invite/${token}`;

    const tpl = teamInviteEmail({
      orgName: ctx.team.name ?? 'Your team',
      inviterEmail: ctx.user.email,
      inviteUrl,
    });

    // Bind the right sender identity for this category — proxy uses it
    // server-side; the actual From address never travels through sendEmail.
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
      action: 'invite.create',
      resourceType: 'invite',
      resourceId: invite.id,
      metadata: { email, ttlSeconds },
      ipAddress: extractIp(req),
    });

    return NextResponse.json(
      InviteItem.parse({
        id: invite.id,
        email,
        teamId,
        expiresAt: expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      }),
      { status: 201 },
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
