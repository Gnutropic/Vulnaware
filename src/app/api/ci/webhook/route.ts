// @polsia:user-owned — Public bearer-token CI ingest endpoint.
// POST /api/ci/webhook accepts the same body shape as the existing
// /api/v1/webhooks/trigger route but gates with a single factor
// (Authorization: Bearer <plaintext>) instead of the HMAC + X-API-Key
// two-factor posture. Pre-creates a queued Scan row tagged source='ci-webhook'
// so the existing /alerts chip filter (found via Scan.source join) picks it
// up immediately, then fire-and-forgets the actual scan run.
//
// Posture:
//   401 — missing/malformed Authorization header or wrong token.
//   503 'ci_webhook_token_not_configured' — no CI_WEBHOOK_TOKEN and no
//     CI_WEBHOOK_TOKENS_JSON wired at deploy time. Mirrors /api/v1/*'s
//     api_key_not_configured posture (fail-closed cold-deploy signal).
//   400 — body fails the contract, target missing, port outside allowlist.
//   202 — queued. The Scan row already lands in the Scans page at this
//     status; the background chain flips it to running → completed/failed
//     without blocking the inbound handshake.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { lookupCiWebhookToken } from '@/lib/business/ci-webhook';
import { runScan } from '@/lib/business/scanner/run-scan';
import { CiWebhookTriggerBody, CiWebhookTriggerResponse } from '@/lib/contracts/ci-webhook';
import { HOSTNAME_OR_IP, PORT_ALLOWLIST } from '@/lib/contracts/scan';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const DEFAULT_PORTS: ReadonlyArray<22 | 80 | 443 | 8080 | 8443> = [443];

const AUTH_HEADER = 'authorization';

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

function notConfigured(): NextResponse {
  return NextResponse.json({ error: 'ci_webhook_token_not_configured' }, { status: 503 });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

function bearerToken(req: Request): string | null {
  const raw = req.headers.get(AUTH_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const supplied = bearerToken(req);
      if (!supplied) return unauthorized();

      const ctx = await lookupCiWebhookToken(supplied);
      if (ctx === 'not_configured') return notConfigured();
      if (ctx === null) return unauthorized();

      setRequestAuth({ teamId: ctx.teamId });

      // Parse the body now that auth has stamped the request logger.
      let json: unknown;
      try {
        json = await req.json();
      } catch {
        return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
      }

      const parsed = CiWebhookTriggerBody.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          { code: 'bad_request', issues: parsed.error.issues },
          { status: 400 },
        );
      }

      // Resolve target: prefer body.target, fall back to repository.url
      // hostname. Both routes must pass HOSTNAME_OR_IP (RFC1918/loopback
      // blocked). An explicit bad target is a misconfigured pipeline — let
      // it fail loudly rather than silently fall through.
      let target: string | null = null;
      const explicitTarget = parsed.data.target;
      if (typeof explicitTarget === 'string' && explicitTarget.length > 0) {
        if (HOSTNAME_OR_IP.safeParse(explicitTarget).success) {
          target = explicitTarget;
        }
      }
      if (!target && parsed.data.repository?.url) {
        try {
          const repoUrl = new URL(parsed.data.repository.url);
          if (HOSTNAME_OR_IP.safeParse(repoUrl.hostname).success) {
            target = repoUrl.hostname;
          }
        } catch {
          // Malformed URL falls through to the 400 below.
        }
      }
      if (!target) {
        return NextResponse.json(
          { code: 'bad_request', message: 'target or repository.url required' },
          { status: 400 },
        );
      }

      const candidatePorts: ReadonlyArray<number> = parsed.data.ports ?? DEFAULT_PORTS;
      const portsCheck = z.array(PORT_ALLOWLIST).min(1).max(5).safeParse(candidatePorts);
      if (!portsCheck.success) {
        return NextResponse.json(
          { code: 'bad_request', message: 'port not in allowlist' },
          { status: 400 },
        );
      }

      const mode = parsed.data.mode ?? 'tcp-only';
      const startedAt = new Date();

      // Pre-create a queued Scan row tagged source='ci-webhook' so the
      // existing /alerts chip filter (Scan.source -> finding.scan.source)
      // picks it up the next time the page polls. The WebhookTrigger side
      // table is intentionally skipped: it's HMAC-anchored (webhookId +
      // signatureAlgorithm) and this endpoint is HMAC-less; the per-scan
      // source stamp is what the alerts filter reads, not the side row.
      const queued = await prisma.scan.create({
        data: {
          target,
          mode,
          status: 'queued',
          startedAt,
          teamId: ctx.teamId,
          source: 'ci-webhook',
        },
        select: { id: true, startedAt: true },
      });

      const out = CiWebhookTriggerResponse.parse({
        id: queued.id,
        target,
        mode,
        status: 'queued',
        startedAt: queued.startedAt.toISOString(),
        finishedAt: null,
        teamId: ctx.teamId,
        source: 'ci-webhook',
      });

      // Fire-and-forget the actual scan. A throw never bubbles back into
      // the inbound handler — the queued row remains visible on the Scans
      // page as a tombstone of the request, same posture as the v1 trigger.
      void (async () => {
        try {
          await runScan(
            { target, ports: portsCheck.data, mode },
            { teamId: ctx.teamId, scanIdOverride: queued.id, source: 'ci-webhook' },
          );
        } catch {
          // Best-effort: the row stays in its inferred state. Surfaced via
          // the Scans page; never bubbles into the 202 handshake.
        }
      })().catch(() => {
        /* swallowed — best-effort */
      });

      return NextResponse.json(out, { status: 202 });
    }),
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
