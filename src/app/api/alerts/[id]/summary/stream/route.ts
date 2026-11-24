// @polsia:user-owned — Per-alert streamed "Stakeholder summary" brief.
// Lives at /api/alerts/[id]/summary/stream and mirrors the posture of
// the sibling explain/remediation routes verbatim: same auth gate, same
// opaque 404 ordering, same 30s server-side timeout, same SSE byte-
// forward relay. The two differences a reader needs to track:
//   - the upstream `task` tag is 'cve-summary' (matches the cached
//     JSON summary route's tag so the platform proxy meters these two
//     callers against the same bucket);
//   - the prompt asks for a single 3–5 sentence PARAGRAPH aimed at
//     non-technical leadership — NOT a bullet checklist and NOT a
//     remediation walk-through. The streamed bytes land on a `<p>`
//     inside the StakeholderSummaryCard; no step-list parsing happens.
//
// Access-control posture mirrors explain/route.ts + remediation/stream
// verbatim:
//   - POST is gated by requireTeamRole('member'); viewers (and below)
//     get 403; unauthenticated callers get 401.
//   - The Prisma read is scoped by `where: { id, teamId }`.
//   - 30s server-side AbortController timeout.
//   - Cross-team id (or fully missing row) → opaque 404 BEFORE any AI.
//
// Fail-closed:
//   - Missing POLSIA_API_KEY / POLSIA_API_TOKEN → 503 { error:
//     'unavailable' }.
//   - AiConfigurationError + any upstream throw → 503 'unavailable'.
//   - Any other failure → 500 JSON.

import 'server-only';
import { NextResponse } from 'next/server';
import { AiConfigurationError, streamChat } from '@/lib/ai/client';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { AlertSummaryUnavailable } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

const STREAM_TIMEOUT_MS = 30_000;

function unavailable() {
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
  // Executive brief ONLY — single paragraph aimed at non-technical
  // leadership. No markdown, no bullets, no headings, no JSON. Strict
  // bounding keeps the model cheap and the output a paste-ready snippet
  // the operator can hand to a VP without reformatting.
  const system =
    'You are writing an executive brief for non-technical leadership about a ' +
    'CVE that just landed on one of our team’s assets. Return a single ' +
    'plain-English paragraph (no markdown, no bullets, no headings, no code ' +
    'fences, no JSON) of between 3 and 5 sentences, targeting ~110 words ' +
    'and never exceeding 700 characters total.\n' +
    'Cover exactly four beats inline as sentences:\n' +
    '  1) what the business impact could be if exploited (data exposure, ' +
    'outage, regulatory/brand risk — speak in terms leadership cares about),\n' +
    '  2) why it matters now (KEV listing, CVSS score, exploitability, ' +
    'whether anyone is actively attacking it),\n' +
    '  3) the one-line a leader should hear first in a 30-second briefing,\n' +
    '  4) what leadership should verify AFTER the patch lands (which ' +
    'systems were scanned, which log signals confirm the fix, what to ' +
    'communicate to customers or regulators if any).\n' +
    'Use the host/IP/port to ground the asset posture; assume the asset is ' +
    'internet-reachable unless evidence is otherwise apparent. Avoid ' +
    'speculation beyond what CVSS plus the description plus the asset ' +
    'posture justify. Do not start any sentence with "The", "This", "It", ' +
    'or "Additionally"; lead each sentence with the subject it concerns.';
  const user =
    `CVE: ${input.cveId}\n` +
    `CVSS: ${input.cvssScore ?? 'unknown'}\n` +
    `Severity: ${input.severity ?? 'unknown'}\n` +
    `Source feed: ${input.source === 'kev' ? 'kev' : 'vulncheck'}\n` +
    `Affected asset: host=${input.asset.host}, ip=${input.asset.ip}, ` +
    `port=${input.asset.port}/${input.asset.protocol}\n` +
    `Description: ${input.description || '(no description ingested yet)'}\n\n` +
    'Write one short executive brief paragraph for leadership about this ' +
    'CVE on this asset.';
  return { system, user };
}

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

      const cveId = alert.finding?.cveId ?? 'UNKNOWN';
      const cveEntry =
        cveId !== 'UNKNOWN'
          ? await prisma.cveEntry.findUnique({
              where: { cveId },
              select: { cvssScore: true, description: true },
            })
          : null;

      const prompt = buildPrompt({
        cveId,
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

      // 30s server-side timeout. Mirror the explain + remediation
      // routes exactly so a hung proxy closes deterministically instead
      // of leaking tokens.
      const ac = new AbortController();
      const timeoutHandle = setTimeout(() => ac.abort(new Error('timeout')), STREAM_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await streamChat({
          task: 'cve-summary',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (err instanceof AiConfigurationError) {
          return NextResponse.json(unavailable(), { status: 503 });
        }
        return NextResponse.json(unavailable(), { status: 503 });
      }

      clearTimeout(timeoutHandle);

      // Relay the OpenAI-compatible SSE stream straight through to the
      // browser. Word-for-word mirror of explain + remediation POST
      // routes — no parse, no transform — so the client-side island
      // reuses the same TextDecoder/SSE pump close to the explain card
      // verbatim.
      return new Response(upstream.body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
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
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
