// @polsia:user-owned — Invite-accept endpoint. Convert a delivered invite
// token into a Membership on the invited team.
//
// POST /api/invites/[token]/accept
// Body: { password: string, name?: string }  (InviteAcceptRequest)
// Re-hashes the token, looks up the Invite row, and either signs the
// recipient in (existing account matching invite email) or signs them up
// fresh. Either way, the resulting session cookie is forwarded onto the
// outgoing response so the client can hard-navigate to /dashboard without
// losing the auth state.
//
// 404 — token resolves to no row OR expiresAt < now
// 410 — Invite.acceptedAt is already set
// 409 — the request is carrying a session whose email differs from the
//        invite email (sign out before accepting this invitation)
// 409 — the recipient is already a member of a different team
// 400 — better-auth rejected the password or signup body
//
// On success returns InviteAcceptResponse (`{ ok: true, redirect: '/dashboard' }`)
// so the client island can redirect the user to the right landing surface.
// Audit + confirmation email fire AFTER durability — same envelope the
// invite issuer uses.

import 'server-only';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { audit, extractIp } from '@/lib/business/audit';
import { removeProvisionalWorkspace } from '@/lib/business/default-workspace';
import { InviteAcceptRequest, InviteAcceptResponse } from '@/lib/contracts/invites';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { inviteAcceptedEmail } from '@/lib/email/templates';
import { env } from '@/lib/env';
import { hashInviteToken } from '@/lib/invite-token';

export const dynamic = 'force-dynamic';

// Forward every Set-Cookie the upstream better-auth Response carries onto
// the outgoing NextResponse. better-auth sets one or two cookies (session
// + csrf); we attach each one as its own header so the browser persists them.
function forwardCookies(out: NextResponse, source: Response): void {
  const getSet = (source.headers as Headers).getSetCookie?.() ?? [];
  if (getSet.length > 0) {
    for (const c of getSet) out.headers.append('set-cookie', c);
    return;
  }
  const single = source.headers.get('set-cookie');
  if (single) out.headers.append('set-cookie', single);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const tokenHash = hashInviteToken(token);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }
    const parsed = InviteAcceptRequest.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
    }
    const { password, name } = parsed.data;

    const invite = await prisma.invite.findFirst({
      where: { tokenHash },
      select: {
        id: true,
        email: true,
        teamId: true,
        expiresAt: true,
        acceptedAt: true,
        invitedByUserId: true,
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
      select: { id: true, name: true },
    });
    if (!team) {
      // Orphaned invite — treat as invalid rather than 500.
      return NextResponse.json({ status: 'invalid' }, { status: 404 });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: invite.email.toLowerCase() },
      select: { id: true },
    });

    // Cross-team collision: if the (existing) user already has a Membership
    // on a different team, refuse before we even talk to better-auth — one
    // team per user for this revision (Membership.userId @unique). Fresh
    // signups can't have a membership yet, so this check is a no-op when
    // `existingUser` is null. Mirrors the issuer's 409 posture.
    if (existingUser) {
      const existingMembership = await prisma.membership.findUnique({
        where: { userId: existingUser.id },
        select: { id: true, teamId: true },
      });
      if (existingMembership && existingMembership.teamId !== invite.teamId) {
        return NextResponse.json({ error: 'Already on another workspace.' }, { status: 409 });
      }
    }

    // Reject if a session is attached and the email doesn't match the
    // invite — accepting an invite while signed in as someone else would
    // either drop or rewrite their team unexpectedly. Same posture as
    // MembershipAssign on the issuer side.
    const session = await auth.api.getSession({ headers: await headers() });
    if (session?.user && session.user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return NextResponse.json(
        { error: 'Sign out before accepting this invitation.' },
        { status: 409 },
      );
    }

    // Sign the user in (existing account) OR create the user (new account).
    // better-auth's `asResponse: true` returns a Response carrying the
    // Set-Cookie headers we need to forward onto the outgoing NextResponse.
    let authResponse: Response;
    let userId: string;

    if (existingUser) {
      const signIn = await auth.api.signInEmail({
        body: { email: invite.email, password },
        asResponse: true,
      });
      if (!signIn.ok) {
        return NextResponse.json({ error: 'Incorrect email or password.' }, { status: 401 });
      }
      authResponse = signIn;
      userId = existingUser.id;
    } else {
      const signupName =
        name && name.trim().length > 0 ? name.trim() : (invite.email.split('@')[0] ?? 'user');
      const signUp = await auth.api.signUpEmail({
        body: { email: invite.email, password, name: signupName },
        asResponse: true,
      });
      if (!signUp.ok) {
        return NextResponse.json(
          { error: 'Could not create the account — try a different password.' },
          { status: 400 },
        );
      }
      // Body is `{ user, session, token }` — read from a clone so the
      // original response body stays intact for cookie forwarding.
      const signUpBody = (await signUp.clone().json()) as { user?: { id?: string } };
      authResponse = signUp;
      userId = signUpBody.user?.id ?? '';
    }

    if (!userId) {
      return NextResponse.json({ error: 'Could not resolve user id.' }, { status: 500 });
    }

    // Membership write + invite delete in ONE transaction. On a fresh
    // account, the Better Auth after-hook also created a provisional default
    // Workspace; move the user to the invited team and remove that root in
    // this transaction so invitation signup keeps its existing team scope.
    //
    // The Invite schema doesn't carry a role column, so all accepted
    // invites default to 'member'. Team admins promote to 'admin' from the
    // team settings page after the recipient lands. WorkspaceMember is the
    // canonical roster entry — we flip the pending row to status='active'
    // here so the GET /api/team/memberships response surfaces the new
    // member immediately, even when the legacy invite pre-dates
    // WorkspaceMember (regression safety).
    const createdTeam = team.name ?? 'Your team';
    const normalizedInviteEmail = invite.email.toLowerCase();
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const previousMembership = await tx.membership.findUnique({
        where: { userId },
        select: { teamId: true },
      });
      await tx.membership.deleteMany({ where: { userId } });
      await tx.membership.create({
        data: {
          userId,
          teamId: invite.teamId,
          role: 'member',
        },
      });
      await tx.invite.delete({ where: { id: invite.id } });
      await tx.workspace.upsert({
        where: { id: invite.teamId },
        create: { id: invite.teamId, name: createdTeam, ownerUserId: null },
        update: {},
      });
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_email: {
            workspaceId: invite.teamId,
            email: normalizedInviteEmail,
          },
        },
        update: {
          status: 'active',
          joinedAt: now,
          userId,
        },
        create: {
          workspaceId: invite.teamId,
          email: normalizedInviteEmail,
          role: 'member',
          status: 'active',
          joinedAt: now,
          userId,
          invitedAt: now,
          invitedByUserId: invite.invitedByUserId,
        },
      });
      if (previousMembership && previousMembership.teamId !== invite.teamId) {
        await removeProvisionalWorkspace(tx, userId, previousMembership.teamId);
      }
    });

    void audit({
      actorUserId: userId,
      actorTeamId: invite.teamId,
      action: 'invite.accept',
      resourceType: 'invite',
      resourceId: invite.id,
      metadata: {
        via: existingUser ? 'signin' : 'signup',
        invitedByUserId: invite.invitedByUserId,
        role: 'member',
      },
      ipAddress: extractIp(req),
    });

    // Confirmation email — same envelope as the issuer / audit side-effects.
    const dashboardUrl = `${(env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/dashboard`;
    const tpl = inviteAcceptedEmail({ orgName: createdTeam, dashboardUrl });
    await sendEmail({
      to: invite.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });

    const out = NextResponse.json(
      InviteAcceptResponse.parse({ ok: true, redirect: '/dashboard' }),
      { status: 200 },
    );
    forwardCookies(out, authResponse);
    return out;
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
