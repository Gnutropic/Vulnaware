// @polsia:user-owned — Per-alert streamed "Fix preview" code snippet.
// Lives at /api/alerts/[id]/fix-snippet/stream and mirrors the posture
// of the sibling remediation/stream route verbatim: same auth gate,
// same opaque 404 ordering, same 30s server-side timeout, same SSE
// byte-forward relay. The only differences a reader needs to track:
//   - the upstream `task` tag is 'cve-fix-snippet' (so the platform
//     proxy meters it on the right bucket);
//   - the prompt asks for ONE machine-pasteable code or config line
//     the operator can drop straight into a Dockerfile, package.json,
//     nginx.conf, Apache config, sshd_config, sysctl invocation, or
//     shell command — NOT prose, NOT multiple blocks, NOT headings.
//     The client strips any leading/trailing markdown fence and
//     renders the result inside a `<pre><code>` so the operator's
//     paste preserves the exact byte layout (whitespace-pre, not
//     whitespace-pre-wrap).
//
// Access-control posture mirrors remediation/stream verbatim:
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
  // ONE paste-ready line. The platform stream decoder pumps raw
  // delta.content fragments into the client's accumulator; the
  // island strips any leading/trailing markdown fence and renders the
  // joined string inside a `<pre><code>` with whitespace-pre so the
  // operator's paste preserves the exact byte layout. Strict bounding
  // (≤ 220 chars/line, ≤ 800 chars total) keeps the model cheap and
  // the output guaranteed to be a single block operators can act on.
  const system =
    'You write a single, machine-pasteable code or config line for a ' +
    'security operator who has just triaged a CVE on one host.\n' +
    'Return EXACTLY ONE line — no prose, no JSON, no headings, no ' +
    'multi-line explanations, no multiple code blocks, no closing ' +
    'remarks. The line must be paste-ready into ONE of:\n' +
    '  - a Dockerfile RUN line (e.g. `RUN apk add --no-cache openssl>=1.0.1g`),\n' +
    '  - a package.json `dependencies` entry (e.g. `"openssl": ">=1.0.1g"`),\n' +
    '  - an nginx.conf `server { ... }` or http block line,\n' +
    '  - an Apache httpd config line (e.g. `ServerTokens Prod`),\n' +
    '  - an sshd_config / ssh_config directive,\n' +
    '  - a sysctl invocation (e.g. `sysctl -w net.ipv4...`),\n' +
    '  - a single shell command (e.g. `apt-get install --only-upgrade openssl`).\n' +
    'Do NOT emit markdown fences, do NOT prefix with "•" "-" "*" or a ' +
    'numeric preamble; the line must be ≤ 220 chars; total output ' +
    '≤ 800 chars. Strip any code-fence markdown you would otherwise ' +
    'emit.';
  const user =
    `CVE: ${input.cveId}\n` +
    `CVSS: ${input.cvssScore ?? 'unknown'}\n` +
    `Severity: ${input.severity ?? 'unknown'}\n` +
    `Source feed: ${input.source === 'kev' ? 'kev' : 'vulncheck'}\n` +
    `Affected asset: host=${input.asset.host}, ip=${input.asset.ip}, ` +
    `port=${input.asset.port}/${input.asset.protocol}\n` +
    `Description: ${input.description || '(no description ingested yet)'}\n\n` +
    'Authoritative remediation anchors (pick the ONE paste-ready line ' +
    'that best matches):\n' +
    `- recommendedFix: ${input.seedAnchor.recommendedFix}\n` +
    (input.seedAnchor.fixVersionOrPatch
      ? `- fixVersionOrPatch: ${input.seedAnchor.fixVersionOrPatch}\n`
      : '') +
    'Return ONE single paste-ready line for THIS asset.';
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
      // suggested-fix / streamed remediation routes use, so the
      // operator's mental model stays consistent across all four
      // streamed surfaces on this alert.
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

      // 30s server-side timeout. Mirror the remediation route exactly
      // so a hung proxy closes deterministically instead of leaking
      // tokens.
      const ac = new AbortController();
      const timeoutHandle = setTimeout(() => ac.abort(new Error('timeout')), STREAM_TIMEOUT_MS);

      let upstream: Response;
      try {
        upstream = await streamChat({
          task: 'cve-fix-snippet',
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

      // Byte-forward relay — no parse, no transform — so the
      // client-side island can reuse the same TextDecoder +
      // SSE-pump pattern the sibling cards use.
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
