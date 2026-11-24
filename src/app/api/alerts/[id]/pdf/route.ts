// @polsia:user-owned — Workspace-authorized alert remediation brief export.

import 'server-only';
import { NextResponse } from 'next/server';
import { brand } from '@/lib/brand';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import {
  type AlertPdfAsset,
  type AlertPdfComment,
  type AlertPdfInput,
  type AlertPdfNote,
  mapAlertPdfDocument,
  parseCachedAlertFixSteps,
} from '@/lib/business/alerts/pdf-render';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { renderDocumentPdf, UnsupportedPdfCharacterError } from '@/lib/pdf/client';

export const dynamic = 'force-dynamic';

const NOTES_LIMIT = 50;
const COMMENTS_LIMIT = 50;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    try {
      // Single primary-key lookup — every column we ship in the PDF
      // (severity, status, source, ownerId, acknowledgedAt, snoozedUntil,
      // all of the close/reopen/rem stamp columns, falsePositiveReason)
      // rides this row. The cross-team posture mirrors /api/alerts/[id]:
      // filter on (id, teamId) so a non-member gets the same opaque 404
      // for "missing row" and "cross-team id".
      const row = await prisma.alert.findFirst({
        where: { id, teamId },
        include: {
          finding: {
            select: {
              cveId: true,
              lastRescoreAt: true,
              epssScore: true,
              asset: { select: { host: true, ip: true, port: true, protocol: true } },
              scan: { select: { source: true } },
            },
          },
        },
      });

      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { name: true },
      });
      const teamName = team?.name ?? 'Team';

      // CVE description + CVSS score — second query, cheap primary-key
      // lookup. CveEntry.cveId is the per-row unique handled above.
      // EPSS lives on VulnerabilityFinding (already in the include above);
      // if a CveEntry doesn't exist yet (entry never ingested) we still
      // stamp the row with the finding's EPSS.
      let cveDescription = '';
      let cvssScore: number | null = null;
      const cveIdString = row.finding?.cveId ?? '';
      if (cveIdString) {
        const cveEntry = await prisma.cveEntry.findUnique({
          where: { cveId: cveIdString },
          select: { cvssScore: true, description: true },
        });
        if (cveEntry) {
          cveDescription = cveEntry.description ?? '';
          cvssScore = cveEntry.cvssScore ?? null;
        }
      }

      // Cached AI fix steps are informational only. The version check keeps
      // stale guidance out of the export, and malformed cache data becomes an
      // explicit unavailable section rather than a failed download.
      const fixRow = await prisma.alertCveFix.findFirst({
        where: { alertId: id, teamId },
        select: { fixStepsJson: true, promptVersion: true },
      });
      const fixSteps = parseCachedAlertFixSteps(fixRow?.fixStepsJson, fixRow?.promptVersion);

      // Timeline notes — DESC (newest first), matching the on-screen pane.
      const noteRows = await prisma.alertNote.findMany({
        where: { alertId: id },
        orderBy: { createdAt: 'desc' },
        take: NOTES_LIMIT,
        select: { id: true, authorUserId: true, body: true, createdAt: true },
      });
      const noteAuthorIds = Array.from(new Set(noteRows.map((n) => n.authorUserId)));
      const noteAuthors = noteAuthorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: noteAuthorIds } },
            select: { id: true, email: true },
          })
        : [];
      const noteEmailById = new Map(noteAuthors.map((u) => [u.id, u.email ?? null] as const));
      const notes: AlertPdfNote[] = noteRows.map((n) => ({
        authorEmail: noteEmailById.get(n.authorUserId) ?? null,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
      }));

      // Assignee update-note thread — ASC chronological, matching the
      // on-screen panel.
      const commentRows = await prisma.alertComment.findMany({
        where: { alertId: id },
        orderBy: { createdAt: 'asc' },
        take: COMMENTS_LIMIT,
        select: { id: true, authorId: true, body: true, createdAt: true },
      });
      const commentAuthorIds = Array.from(new Set(commentRows.map((c) => c.authorId)));
      const commentAuthors = commentAuthorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: commentAuthorIds } },
            select: { id: true, name: true },
          })
        : [];
      const commentNameById = new Map(commentAuthors.map((u) => [u.id, u.name ?? null] as const));
      const comments: AlertPdfComment[] = commentRows.map((c) => ({
        authorName: commentNameById.get(c.authorId) ?? null,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      }));

      // Owner display — scalar FK on WorkspaceMember.id, peer-read
      // through to User (no Prisma relation since User lives in the
      // locked auth.prisma). Email is preferred when both are
      // available so the lifecycle stamp has something unambiguous;
      // null flips to "—" in the renderer.
      let ownerName: string | null = null;
      let ownerEmail: string | null = null;
      if (row.ownerId) {
        const member = await prisma.workspaceMember.findFirst({
          where: { id: row.ownerId, status: 'active' },
          select: { userId: true },
        });
        if (member?.userId) {
          const u = await prisma.user.findUnique({
            where: { id: member.userId },
            select: { name: true, email: true },
          });
          ownerName = u?.name ?? null;
          ownerEmail = u?.email ?? null;
        }
      }

      // Scan source derived as 'kev' / 'vulncheck' / 'manual' — the
      // scan row's `source` column is what the on-screen "Triggered by"
      // badge maps from. Map to TriggeredByEnum; the schema is loose so
      // legacy/hand-stamped values land at `manual`.
      const rawTrigger = row.finding?.scan?.source ?? null;
      const triggeredBy: AlertPdfInput['triggeredBy'] =
        rawTrigger === 'ci-webhook' || rawTrigger === 'scheduled' ? rawTrigger : 'manual';

      const asset: AlertPdfAsset = {
        host: row.finding?.asset?.host ?? '',
        ip: row.finding?.asset?.ip ?? '',
        port: row.finding?.asset?.port ?? 0,
        protocol: row.finding?.asset?.protocol ?? '',
        lastSeen: row.finding?.lastRescoreAt ? row.finding.lastRescoreAt.toISOString() : null,
      };

      const input: AlertPdfInput = {
        brandName: brand.name,
        teamName,
        generatedAt: new Date().toISOString(),
        createdAt: row.createdAt.toISOString(),
        alertId: row.id,
        cveId: cveIdString,
        cvssScore,
        epssScore: row.finding?.epssScore ?? null,
        description: cveDescription,
        severity: row.severity ?? null,
        source: row.source,
        triggeredBy,
        status: row.status,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
        acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
        remediatedAt: row.remediatedAt ? row.remediatedAt.toISOString() : null,
        remediatedByEmail: row.remediatedByEmail ?? null,
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
        closedBy: row.closedBy ?? null,
        closingNote: row.closingNote ?? null,
        falsePositiveReason: row.falsePositiveReason ?? null,
        reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
        reopenedBy: row.reopenedBy ?? null,
        reopenReason: row.reopenReason ?? null,
        ownerName,
        ownerEmail,
        asset,
        notes,
        fixSteps,
        comments,
      };

      let bytes: Uint8Array;
      try {
        bytes = await renderDocumentPdf(mapAlertPdfDocument(input));
      } catch (error) {
        if (error instanceof UnsupportedPdfCharacterError) {
          return NextResponse.json(
            { error: 'unsupported_pdf_character', codePoint: error.codePoint },
            { status: 422 },
          );
        }
        throw error;
      }
      const filename = `alert-${row.id}.pdf`;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
