// @polsia:user-owned — Per-alert cached AI CVE summary. Lives at
// /api/alerts/[id]/summary (not under /api/v1/...) so the access posture
// mirrors the parent GET and the /triage POST: team-scoped + authed, NOT
// token-gated.
//
// Access-control posture:
//   - Both methods are gated by `requireTeamRole('member')` — viewers (and
//     below) get 403; unauthenticated callers get 401.
//   - Every Prisma read/write is scoped by `where: { alertId: id, teamId }`.
//   - POST re-asserts the Alert row's teamId == ctx.membership.teamId BEFORE
//     the AI call so a synthetic alertId from another team can't burn tokens.
//   - Cross-team id (or fully missing row) → opaque 404 (no existence leak).
//
// Fail-closed posture:
//   - GET returns 200 `{ error: 'unavailable' }` when the cache row is
//     missing — the client treats this as "not yet cached; user can click
//     Regenerate". No auto-generate on a plain GET (avoids surprise cost).
//   - POST returns 503 `{ error: 'unavailable' }` when the AI proxy key is
//     absent or the model call fails; the client surfaces a toast and
//     leaves the previous cached text visible (mirrors the triage optimistic-
//     then-revert posture).

import 'server-only';
import { NextResponse } from 'next/server';
import { AiConfigurationError, chat } from '@/lib/ai/client';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertSummary, AlertSummaryUnavailable } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

const PROMPT_VERSION = 'v1';
const MAX_RETURNED_CHARS = 600;
const MODEL_TAG = 'gpt-4o-mini';

// Defensive 600-char cap. The brief asks for ~80 words; the model is told
// that, but we truncate server-side so a runaway re-generation can't blow
// the card layout (the client renders three short bullets).
function truncate(text: string): string {
  return text.length <= MAX_RETURNED_CHARS
    ? text
    : `${text.slice(0, MAX_RETURNED_CHARS).trimEnd()}…`;
}

function unavailable() {
  // The wire shape is `{ error: 'unavailable' }` per the contract — the
  // client treats this as "not cached yet / proxy unavailable" and offers
  // a Regenerate click. Internal-cause codes are logged server-side and
  // never surface to the client.
  return AlertSummaryUnavailable.parse({ error: 'unavailable' });
}

function buildPrompt(input: {
  cveId: string;
  cvssScore: number | null;
  severity: string | null;
  source: 'kev' | 'vulncheck' | 'manual';
  description: string;
  asset: { host: string; ip: string; port: number; protocol: string };
}) {
  const system =
    'You are summarizing a CVE for a security analyst. ' +
    'Return EXACTLY three short bullet lines: ' +
    '1) what is exploitable, ' +
    '2) why the priority (CVSS, KEV, exploit availability, exposure), ' +
    '3) suggested next step. ' +
    'Plain English. No markdown. Total length under 80 words.';
  const user =
    `CVE: ${input.cveId}\n` +
    `CVSS: ${input.cvssScore ?? 'unknown'}\n` +
    `Severity: ${input.severity ?? 'unknown'}\n` +
    `Source feed: ${input.source === 'kev' ? 'kev' : 'vulncheck'}\n` +
    `Affected asset in the team: host=${input.asset.host}, ip=${input.asset.ip}, ` +
    `port=${input.asset.port}/${input.asset.protocol}\n` +
    `Description: ${input.description || '(no description ingested yet)'}\n\n` +
    "Summarize the impact on THIS team's stack in three plain-English bullets.";
  return { system, user };
}

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
      // Re-assert alert + team scope BEFORE the cache read so the same
      // opaque 404 is returned for "wrong team" and "missing row".
      const alert = await prisma.alert.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!alert) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      const row = await prisma.alertCveSummary.findFirst({
        where: { alertId: id, teamId },
        select: { summaryText: true, model: true, generatedAt: true },
      });
      if (!row) {
        return NextResponse.json(unavailable(), { status: 200 });
      }

      const parsed = AlertSummary.parse({
        alertId: id,
        text: row.summaryText,
        generatedAt: row.generatedAt.toISOString(),
        model: row.model ?? null,
      });
      return NextResponse.json(parsed);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

// POST = trigger a fresh AI call and write through to the per-alert cache
// (keyed on alertId). Body is intentionally ignored — the resource is the
// alert itself, and the user gesture is "click Regenerate".
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

    try {
      // AI proxy key REQUIRED for POST. We check up-front so missing-key
      // gets the documented 503 posture; the chat() helper throws
      // AiConfigurationError if the runtime key vanishes between this check
      // and the call (the catch maps both to 'unavailable' on the wire).
      if (!env.POLSIA_API_KEY && !env.POLSIA_API_TOKEN) {
        return NextResponse.json(unavailable(), { status: 503 });
      }

      // Scope check FIRST. Cross-team probing MUST NOT trigger an
      // expensive model call.
      const alert = await prisma.alert.findFirst({
        where: { id, teamId },
        select: {
          id: true,
          severity: true,
          source: true,
          finding: {
            select: {
              cveId: true,
              asset: { select: { host: true, ip: true, port: true, protocol: true } },
            },
          },
        },
      });
      if (!alert) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      // Description is sourced from CveEntry (free-form cveId join — same
      // pattern as /api/alerts/[id]). The second query is keyed on cveId
      // (indexed), so it's a small slice.
      const cveEntry = alert.finding?.cveId
        ? await prisma.cveEntry.findUnique({
            where: { cveId: alert.finding.cveId },
            select: { cvssScore: true, description: true },
          })
        : null;

      const prompt = buildPrompt({
        cveId: alert.finding?.cveId ?? 'UNKNOWN',
        cvssScore: cveEntry?.cvssScore ?? null,
        severity: alert.severity ?? null,
        source: alert.source,
        description: cveEntry?.description ?? '',
        asset: {
          host: alert.finding?.asset?.host ?? '',
          ip: alert.finding?.asset?.ip ?? '',
          port: alert.finding?.asset?.port ?? 0,
          protocol: alert.finding?.asset?.protocol ?? '',
        },
      });

      let rawText: string;
      try {
        // The ai module's chat() is server-only, hits the Polsia AI
        // proxy under POLSIA_API_KEY, and returns just the assistant text.
        rawText = await chat({
          task: 'cve-summary',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        });
      } catch (err) {
        if (err instanceof AiConfigurationError) {
          return NextResponse.json(unavailable(), { status: 503 });
        }
        return NextResponse.json(unavailable(), { status: 503 });
      }

      const summaryText = truncate(rawText.trim());
      const generatedAt = new Date();

      // Upsert keyed on alertId (PK). teamId is denormalized at write
      // time; the read path re-checks it.
      await prisma.alertCveSummary.upsert({
        where: { alertId: id },
        create: {
          alertId: id,
          teamId,
          summaryText,
          model: MODEL_TAG,
          promptVersion: PROMPT_VERSION,
          generatedAt,
        },
        update: {
          summaryText,
          model: MODEL_TAG,
          promptVersion: PROMPT_VERSION,
          generatedAt,
        },
      });

      const parsed = AlertSummary.parse({
        alertId: id,
        text: summaryText,
        generatedAt: generatedAt.toISOString(),
        model: MODEL_TAG,
      });
      return NextResponse.json(parsed);
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
