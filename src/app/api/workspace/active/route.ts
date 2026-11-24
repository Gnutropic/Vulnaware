// @polsia:user-owned — Authenticated active workspace accessor and setter.
import 'server-only';
import { NextResponse } from 'next/server';
import {
  ACTIVE_WORKSPACE_COOKIE,
  ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS,
  canAccessWorkspace,
  resolveActiveWorkspaceId,
} from '@/lib/business/active-workspace';
import {
  ActiveWorkspaceResponse,
  ActiveWorkspaceSelectionRequest,
} from '@/lib/contracts/active-workspace';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

async function authenticatedUser(request: Request): Promise<SessionUser | Response> {
  try {
    return await requireAuth(request);
  } catch (response) {
    return response as Response;
  }
}

export async function GET(request: Request) {
  const user = await authenticatedUser(request);
  if (user instanceof Response) return user;

  try {
    const workspaceId = await resolveActiveWorkspaceId(user.id);
    if (!workspaceId) {
      return NextResponse.json({ error: 'No workspace available' }, { status: 404 });
    }
    return NextResponse.json(ActiveWorkspaceResponse.parse({ workspaceId }));
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await authenticatedUser(request);
  if (user instanceof Response) return user;

  const body = await request.json().catch(() => undefined);
  const parsed = ActiveWorkspaceSelectionRequest.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] === undefined ? 'body' : String(issue.path[0]);
      errors[field] ??= issue.message;
    }
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    const { workspaceId } = parsed.data;
    if (!(await canAccessWorkspace(user.id, workspaceId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const response = NextResponse.json(ActiveWorkspaceResponse.parse({ workspaceId }));
    response.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
