// @polsia:user-owned — POST /api/alerts/[id]/snooze. Sets or clears the
// `snoozedUntil` window on a team-scoped alert row. Body accepts either
// `{ duration: '1d' | '3d' | '7d' | '30d' }` (the brief's primary shape —
// server stamps a future `until` from the prefix) or `{ until: ISO string
// | null }` (the prior shape retained for the right-column SnoozeCard).
// `null` on either shape clears the snooze (the explicit Un-snooze button).
//
// Server-stamps `until` from `duration` so client clock-skew never
// reaches the row — operators get a consistent post-click countdown no
// matter where they snoozed from. The `until` shape is honored exactly
// when supplied (the SnoozeCard computes the future moment client-side).
//
// Access-control posture mirrors /api/alerts/[id]/triage and /owner:
// gated by requireTeamRole('member'). The `findFirst` lookup is seeded
// with the caller's teamId so a cross-team id (or missing row) returns
// the SAME opaque 404 as a legitimate not-found — no existence-as-leak
// vector.
//
// Lives at /api/alerts/[id]/snooze (not nested under /api/alerts/[id])
// so the GET handler on the parent stays read-only and the 405 stub
// posture carries through.

import 'server-only';
import { NextResponse } from 'next/server';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertItem, AlertSnoozeBody, TriggeredByEnum } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

const DAY_MS = 24 * 60 * 60 * 1000;
// WINDOW_MS aligns the brief's duration enum with the SnoozeCard's
// `WINDOW_OPTIONS` ms table so server-stamped and client-stamped
// SnoozeCard surfaces produce the same on-row countdown when the same
// caller snoozes from both surfaces. Lockstep with the bulk
// snooze-batch route's WINDOW_MS so a 3-armed widening on one route
// cascades to the other. The 3d arm is interleaved between 1d and 7d
// so ascending key order matches the picker layout on the /alerts
// bulk-bar popover.
const WINDOW_MS: Record<'1d' | '3d' | '7d' | '30d', number> = {
  '1d': DAY_MS,
  '3d': 3 * DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });

    const { id } = await params;
    const teamId = ctx.workspaceId;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { errors: { _: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const parsed = AlertSnoozeBody.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const errors: Record<string, string> = {};
      for (const [field, messages] of Object.entries(fieldErrors)) {
        const first = messages?.[0];
        if (first) errors[field] = first;
      }
      if (Object.keys(errors).length === 0) errors._ = 'Invalid request body.';
      return NextResponse.json({ errors }, { status: 400 });
    }

    // Map the brief's `{ duration }` arm to a server-stamped `until` so the
    // existing write path (single `data: { snoozedUntil }`) works unchanged
    // for both inbound shapes. The `{ until }` arm is passed through verbatim
    // — its SnoozeCard origin already computed the future moment client-side.
    const until: string | null =
      'duration' in parsed.data
        ? new Date(Date.now() + WINDOW_MS[parsed.data.duration]).toISOString()
        : (parsed.data.until ?? null);

    try {
      // Cross-team / not-found gate — opaque 404 same as the GET and the
      // triage / owner routes. A caller can't distinguish "no alert" from
      // "wrong team" from "right team, wrong id".
      const existing = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      await prisma.alert.update({
        where: { id },
        // null clears (Un-snooze); ISO string stamps the new window. The
        // list route's `where` narrows by `(IS NULL OR <= now)` so a
        // past-dated `until` surfaces immediately on the next refresh —
        // intentionally NO 400 here, the operator can pre-snooze to a
        // past moment only via the explicit null path.
        data: { snoozedUntil: until ? new Date(until) : null },
      });

      // Re-read with the same shape as the list endpoint so the response
      // parses against AlertItem (one contract, every route).
      const row = await prisma.alert.findUnique({
        where: { id },
        include: {
          finding: {
            select: {
              cveId: true,
              asset: { select: { host: true, port: true, protocol: true } },
              scan: { select: { source: true } },
            },
          },
        },
      });
      if (!row || row.teamId !== teamId) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      const rawSource = row.finding?.scan?.source ?? null;
      const triggeredByResult =
        rawSource == null ? undefined : TriggeredByEnum.safeParse(rawSource);
      const triggeredBy = triggeredByResult?.success ? triggeredByResult.data : undefined;

      // Resolve ownerName for the AlertItem response (single row, no
      // batched join — same posture as triage / owner routes).
      let ownerName: string | null = null;
      if (row.ownerId) {
        const member = await prisma.workspaceMember.findFirst({
          where: { id: row.ownerId, status: 'active' },
          select: { userId: true },
        });
        if (member?.userId) {
          const u = await prisma.user.findUnique({
            where: { id: member.userId },
            select: { name: true },
          });
          ownerName = u?.name ?? null;
        }
      }

      const item = AlertItem.parse({
        id: row.id,
        teamId: row.teamId,
        findingId: row.findingId,
        severity: row.severity ?? null,
        status: row.status,
        source: row.source,
        assigneeId: row.assigneeId ?? null,
        ownerId: row.ownerId ?? null,
        ownerName,
        createdAt: row.createdAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
        cveId: row.finding?.cveId ?? '',
        asset: {
          host: row.finding?.asset?.host ?? '',
          port: row.finding?.asset?.port ?? 0,
          protocol: row.finding?.asset?.protocol ?? '',
        },
        triggeredBy,
      });

      return NextResponse.json(item);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
