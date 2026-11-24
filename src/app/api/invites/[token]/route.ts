// @polsia:user-owned — Public invitation lookup endpoint.
//
// GET /api/invites/[token]
// Validates a recipient's emailed invite token. Returns 200 with the public
// `InviteRead` shape when the invite is still pending, 410 when the invite
// has already been consumed (acceptedAt != null), and 404 when the token
// resolves to no row OR is past expiresAt. No auth gate — this route is the
// entry point for fresh signups who do not yet have a session.
//
// Returns the InviteStatus discriminated union as the JSON body in EVERY
// branch (200 included), so the client island can branch deterministically
// from one parsed shape regardless of which HTTP code came back. This avoids
// the "renders fine in a happy-path test, explodes on 410" footgun.
//
// NEVER returns the tokenHash, the invitedByUserId, or any internal id —
// the body only carries what the UI needs to label the form.

import 'server-only';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { hashInviteToken } from '@/lib/invite-token';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tokenHash = hashInviteToken(token);

  const invite = await prisma.invite.findFirst({
    where: { tokenHash },
    select: {
      id: true,
      email: true,
      teamId: true,
      expiresAt: true,
      acceptedAt: true,
    },
  });

  if (!invite) {
    return NextResponse.json({ status: 'invalid' }, { status: 404 });
  }

  if (invite.acceptedAt) {
    return NextResponse.json({ status: 'consumed' }, { status: 410 });
  }

  if (invite.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ status: 'invalid' }, { status: 404 });
  }

  const team = await prisma.team.findUnique({
    where: { id: invite.teamId },
    select: { name: true },
  });

  const existingUser = await prisma.user.findUnique({
    where: { email: invite.email.toLowerCase() },
    select: { id: true },
  });

  return NextResponse.json(
    {
      status: 'pending',
      email: invite.email,
      teamName: team?.name ?? 'Your team',
      existingUser: Boolean(existingUser),
    },
    { status: 200 },
  );
}
