// @polsia:user-owned — Per-alert streamed "Suggested remediation" brief.
// Lives at /api/alerts/[id]/remediation/stream and mirrors the posture
// of the sibling explain route verbatim: same auth gate, same opaque
// 404 ordering, same 30s server-side timeout, same SSE byte-forward
// relay. The only differences a reader needs to track:
//   - the upstream `task` tag is 'cve-remediation' (so the platform
//     proxy meters it on the right bucket);
//   - the prompt asks for 3–5 concrete actions (version lines, patch
//     KB ids, config flags, commands) — NOT prose. The client splits
//     the streamed accumulator into an ordered <ol>.
//
// Access-control posture mirrors explain/route.ts verbatim:
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
import { lookupRemediation } from '@/lib/business/scanner/cve-remediation';
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
  seedAnchor: {
    recommendedFix: string;
    fixVersionOrPatch: string | null;
  };
}) {
  // Steps ONLY (no prose, no headings, no code fences). The platform
  // stream decoder pumps raw delta.content fragments into the client's
  // accumulator; the island post-processes the joined string into a
  // numbered bullet list. Strict bounding keeps the model cheap (3–5
  // items at ≤ 220 chars each) and the model's output parseable without
  // re-running a JSON object schema.
  const system =
    'You write remediation steps for a security operator who has just ' +
    'triaged a CVE on one host. Return EXACTLY between 3 and 5 short ' +
    'remediation steps separated by single newlines, ONE concrete ' +
    'action per line.\n' +
    'Rules — every step must include at least one of:\n' +
    '  - a specific version / minimum-version line (e.g. "OpenSSL >= 1.0.1g"),\n' +
    '  - a patch KB id (e.g. "Apply KB5034439"),\n' +
    '  - a config flag (e.g. "UseRoaming no" in /etc/ssh/ssh_config),\n' +
    '  - a shell command the operator can paste (e.g. "ssh -V").\n' +
    'No prose, no wrapping sentences, no bullet hinges like "Step 1:"; ' +
    'each line ≤ 220 chars; do not start a line with "•" "-" "*" or a ' +
    'numeric prefix; total output ≤ 1100 chars.';
  const user =
    `CVE: ${input.cveId}\n` +
    `CVSS: ${input.cvssScore ?? 'unknown'}\n` +
    `Severity: ${input.severity ?? 'unknown'}\n` +
    `Source feed: ${input.source === 'kev' ? 'kev' : 'vulncheck'}\n` +
    `Affected asset: host=${input.asset.host}, ip=${input.asset.ip}, ` +
    `port=${input.asset.port}/${input.asset.protocol}\n` +
    `Description: ${input.description || '(no description ingested yet)'}\n\n` +
    'Authoritative remediation anchors (use these verbatim where applicable):\n' +
    `- recommendedFix: ${input.seedAnchor.recommendedFix}\n` +
    (input.seedAnchor.fixVersionOrPatch
      ? `- fixVersionOrPatch: ${input.seedAnchor.fixVersionOrPatch}\n`
      : '') +
    'Return between 3 and 5 concrete remediation steps for THIS asset.';
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

      // Deterministic seed anchors — same triplet the cached
      // suggested-fix route uses, so an operator sees the same anchor
      // phrasing even when the streamed path picks a different model
      // temperature.
      const seedAnchor = lookupRemediation(cveId);

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
        seedAnchor: {
          recommendedFix: seedAnchor.recommendedFix,
          fixVersionOrPatch: seedAnchor.fixVersionOrPatch,
        },
      });

      // 30s server-side timeout. Mirror the explain route exactly so a
      // hung proxy closes deterministically instead of leaking tokens.
      const ac = new AbortController();
      const timeoutHandle = setTimeout(() => ac.abort(new Error('timeout')), STREAM_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await streamChat({
          task: 'cve-remediation',
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
      // browser. Word-for-word mirror of the explain route's relay
      // posture — no parse, no transform — so the client-side island
      // can use the SAME TextDecoder/SSE-pump close to the explain
      // card verbatim.
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
