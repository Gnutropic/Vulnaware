// @polsia:user-owned — Team notification settings. Drives the daily
// alert digest toggle rendered by /src/components/custom/team/alert-digest-toggle.tsx.
//
// GET    /api/team/settings  -> { digestEnabled, lastAlertDigestAt } for the caller's team.
// PATCH  /api/team/settings  -> body { digestEnabled: boolean }; both methods
//                                gate through requireTeamRole(...) and parse
//                                through the matching zod schema so the
//                                client island never hand-rolls the wire
//                                shape.
//
// Access posture:
//   - GET     — member-level. Informational; every team member needs to see
//               whether their team is paused.
//   - PATCH   — admin-level. Only admins flip the toggle; under-spec'd
//               callers get 403 from requireTeamRole.
// Both methods return JSON parsed through TeamSettings (single source of
// truth shared with the client island via the contract file).

import 'server-only';
import { NextResponse } from 'next/server';
import { TeamSettings, TeamSettingsPatch } from '@/lib/contracts/team-settings';
import { prisma } from '@/lib/db';
import { requireTeamRole } from '@/lib/team-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await requireTeamRole('member');

    const team = await prisma.team.findUnique({
      where: { id: ctx.membership.teamId },
      select: { digestEnabled: true, lastAlertDigestAt: true },
    });

    return NextResponse.json(
      TeamSettings.parse({
        digestEnabled: team?.digestEnabled ?? true,
        lastAlertDigestAt: team?.lastAlertDigestAt ? team.lastAlertDigestAt.toISOString() : null,
      }),
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
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

    const parsed = TeamSettingsPatch.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) errors._ = 'Invalid settings payload.';
      return NextResponse.json({ errors }, { status: 400 });
    }

    const updated = await prisma.team.update({
      where: { id: ctx.membership.teamId },
      data: { digestEnabled: parsed.data.digestEnabled },
      select: { digestEnabled: true, lastAlertDigestAt: true },
    });

    return NextResponse.json(
      TeamSettings.parse({
        digestEnabled: updated.digestEnabled,
        lastAlertDigestAt: updated.lastAlertDigestAt
          ? updated.lastAlertDigestAt.toISOString()
          : null,
      }),
    );
  } catch (res) {
    if (res instanceof Response) return res;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, PATCH' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
