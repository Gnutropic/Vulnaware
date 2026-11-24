// @polsia:user-owned — Per-alert one-shot AI "Suggest fix steps with
// AI" route. Lives at /api/alerts/[id]/suggest-fix and SITS NEXT TO
// (NOT INSIDE) the cached /api/alerts/[id]/suggested-fix route — the
// cached route persists a per-alert row on every successful regeneration
// and serves a GET on cache hits, while THIS route returns the freshly-
// generated steps directly in the response body. No persistence, no GET.
//
// Reading order on a triple-click on /alerts/[id]:
//   1. /api/alerts/[id]/cve-summary        — `CveSummaryCard` (cached 7-day brief)
//   2. /api/alerts/[id]/suggested-fix      — `SuggestedFixCard`   (cached checklist)
//   3. /api/alerts/[id]/explain/stream     — `ExplainWithAiCard`  (streamed prose)
//   4. /api/alerts/[id]/suggest-fix        — `SuggestFixCard`     (POST → JSON)
//   5. /api/alerts/[id]/remediation/stream — `SuggestedRemediationCard` (streamed)
//
// The four AI panels each serve a distinct verb (Summarize → Fix →
// Explain → Suggest-again → Remediate) and a distinct eyebrow so an
// operator with the same page mounted twice can tell them apart at a
// glance; this route is one of four siblings so the access posture must
// mirror every other /api/alerts/[id]/ AI route verbatim.
//
// Access-control posture:
//   - POST is gated by `requireTeamRole('member')` — viewers (and below)
//     get 403; unauthenticated callers get 401.
//   - Prisma read scoped by `where: { id, teamId }` BEFORE the AI call
//     so a synthetic alertId from another team can't burn tokens.
//   - Cross-team id (or fully missing row) → opaque 404 (no existence
//     leak).
//
// Fail-closed posture:
//   - 503 `{ error: 'unavailable' }` when POLSIA_API_KEY/POLSIA_API_TOKEN
//     are both missing OR the model call throws AiConfigurationError /
//     a generic Error.
//   - 404 `{ error: 'not_found' }` for cross-team probe.
//   - POST JSON parse failure falls through to fallbackSteps so the
//     operator always sees a remediation checklist (it may be the
//     deterministic seed anchor instead of the model's output).

import 'server-only';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { AiConfigurationError, chat } from '@/lib/ai/client';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import { lookupRemediation } from '@/lib/business/scanner/cve-remediation';
import { AlertFixSteps, AlertFixStepsUnavailable } from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

const MAX_TITLE_CHARS = 60;
const MAX_BODY_CHARS = 400;
const MODEL_TAG = 'gpt-4o-mini';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

function unavailable() {
  return AlertFixStepsUnavailable.parse({ error: 'unavailable' });
}

// Stable id so each step key is React-stable across re-mounts on the
// SuggestFixCard. The route is POST-only and doesn't persist rows, but
// keeping a stable hash means the client never has to recompute a key
// when the same fix-step surface is delivered twice in a row.
function stepId(title: string, body: string, position: number): string {
  const hash = createHash('sha256')
    .update(`${position}|${title.trim()}|${body.trim()}`)
    .digest('hex');
  return hash.slice(0, 16);
}

// Deterministic fallback when the model's output is empty — mirrors the
// `lookupRemediation` shape so the UI surfaces a platform-aware
// remediation even when the proxy misbehaves. Returns 2 steps (seed
// recommendedFix + verify) so the upper bound of 6 leaves room for a
// model response that genuinely emits more steps.
function fallbackSteps(cveId: string): { id: string; title: string; body: string }[] {
  const seed = lookupRemediation(cveId);
  const steps: { id: string; title: string; body: string }[] = [];
  steps.push({
    id: '',
    title: truncate(seed.recommendedFix.split('.')[0] || `Address ${cveId}`, MAX_TITLE_CHARS),
    body: truncate(
      `${seed.recommendedFix}${seed.fixVersionOrPatch ? ` (${seed.fixVersionOrPatch})` : ''}`,
      MAX_BODY_CHARS,
    ),
  });
  steps.push({
    id: '',
    title: 'Verify',
    body: truncate(seed.verificationStep, MAX_BODY_CHARS),
  });
  return steps
    .map((step, idx) => ({ ...step, id: stepId(step.title, step.body, idx) }))
    .filter((step) => step.body.length > 0);
}

function normalizeSteps(
  raw: unknown,
  cveId: string,
): { id: string; title: string; body: string }[] {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned: { id: string; title: string; body: string }[] = [];
  list.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as { title?: unknown; body?: unknown };
    const rawTitle = typeof e.title === 'string' ? e.title.trim() : '';
    const rawBody = typeof e.body === 'string' ? e.body.trim() : '';
    if (!rawBody) return;
    const title = truncate(rawTitle || `Step ${idx + 1}`, MAX_TITLE_CHARS);
    const body = truncate(rawBody, MAX_BODY_CHARS);
    cleaned.push({ id: '', title, body });
  });
  if (cleaned.length === 0) return fallbackSteps(cveId);
  return cleaned.slice(0, 6).map((step, idx) => ({
    ...step,
    id: stepId(step.title, step.body, idx),
  }));
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
    verificationStep: string;
  };
}) {
  const system =
    'You are producing a focused remediation checklist for a security analyst. ' +
    'Return STRICT JSON: {"steps":[{"title":"...","body":"..."}]} ' +
    'with BETWEEN 3 AND 6 STEPS (inclusive). ' +
    'Rules: no markdown, no code fences, no preamble; ' +
    'each title ≤ 60 chars; each body ≤ 400 chars and copy-ready ' +
    '(versions/commands verbatim so the operator can paste). ' +
    'Favour concrete commands, config flags, or upgrade lines over prose. ' +
    'Total length ≤ 1600 chars. ' +
    'Order steps from immediate mitigation to verify-back-after-fix.';
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
    `- verificationStep: ${input.seedAnchor.verificationStep}\n\n` +
    "Produce the remediation steps for THIS team's stack.";
  return { system, user };
}

// POST = trigger a fresh AI call and return the parsed envelope
// directly in the response body. Body is intentionally ignored — the
// resource is the alert itself, and the user gesture is "click Suggest
// fix steps with AI". No persistence: each click generates a fresh
// generation stamp; this route does NOT touch the per-alert cache that
// /api/alerts/[id]/suggested-fix owns.
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

      // Deterministic seed anchors (no model call inside lookupRemediation)
      // — the prompt primes the model with curated phrasing for the 8 seed
      // CVEs and a generic fallback for everything else.
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
          verificationStep: seedAnchor.verificationStep,
        },
      });

      let steps: { id: string; title: string; body: string }[];
      try {
        const raw = await chat({
          // Distinct task string from the cached suggested-fix route so
          // the proxy's per-task metering discards the two surfaces
          // separately — being chosen by name (a pasted call site for
          // the cached route) never accidentally fires the one-shot
          // endpoint.
          task: 'cve-suggest-fix',
          responseFormat: 'json_object',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        });
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          decoded = {};
        }
        const rawSteps =
          decoded && typeof decoded === 'object' && 'steps' in decoded
            ? (decoded as { steps: unknown }).steps
            : [];
        steps = normalizeSteps(rawSteps, cveId);
      } catch (err) {
        if (err instanceof AiConfigurationError) {
          return NextResponse.json(unavailable(), { status: 503 });
        }
        return NextResponse.json(unavailable(), { status: 503 });
      }

      const generatedAt = new Date();

      const parsed = AlertFixSteps.parse({
        alertId: id,
        steps,
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
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
