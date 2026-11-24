// @polsia:user-owned — CI/CD webhook intake for shift-left scanning.
// Auth-gated DB-backed scoped API key endpoint that accepts an HMAC-signed
// CI/CD body (target OR repository.url, optional ports/mode/build context).
//
// Flow:
//   1. verifyApiKey (existing) — `verifyApiKey(req)` keeps the v1 surface
//      typed under the bearing key's team.
//   2. capture raw body BEFORE any parse (Next 16 reads the body once).
//   3. require X-Webhook-Id header + verifySignature against the single
//      non-revoked `Webhook` row pinned by (id, teamId). Foreign-team rows
//      decrypt-failures and signature mismatches all return 401 with the
//      same `{error:"unauthorized"}` envelope as the api-key gate.
//   4. parse the body as JSON (deep-copy before the typed zod parse so a
//      second safeParse can rerun on the cached payload — the
//      verifyInboundWebhook call above already consumed the body bytes).
//   5. resolve target / port allowlist / mode (unchanged).
//   6. pre-create a `queued` Scan row + a WebhookTrigger side-table row
//      holding the workspace / repository / build context, then return 201
//      with the queued envelope. The Scans page picks the row up IMMEDIATELY
//      because it filters by teamId regardless of status.
//   7. fire-and-forget `runScan(..., { scanIdOverride })` so the background
//      call flips the pre-created row to running → completed / failed.
//      When the scan settles, signed webhook deliveries go out to the
//      team's registered endpoints. A thrown background error leaves the
//      row at `queued`; that's the documented v1 posture.
//
// Single-scan scope is rejected with 405 — `scanId` is unknown ahead of
// trigger. Mirrors src/app/api/v1/scans/route.ts for auth + envelope posture.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-auth';
import { runScan } from '@/lib/business/scanner/run-scan';
import { deliverWebhook, getWebhookSigningSecret } from '@/lib/business/webhooks';
import { verifyInboundWebhook } from '@/lib/business/webhooks-inbound';
import { HOSTNAME_OR_IP, PORT_ALLOWLIST } from '@/lib/contracts/scan';
import { WebhookTriggerBody, WebhookTriggerResponse } from '@/lib/contracts/scan-api';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const DEFAULT_PORTS: ReadonlyArray<22 | 80 | 443 | 8080 | 8443> = [443];

const WEBHOOK_ID_HEADER = 'x-webhook-id';
const SIGNATURE_HEADER = 'x-vulnaware-signature';

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

// Reject other verbs so a misconfigured CI caller (e.g. a GET probe) gets 405
// rather than a misleading 200/404 from Next's default response.
function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

const CUID_RE = /^c[a-z0-9]+$/;
function isCuid(value: string | null): value is string {
  return typeof value === 'string' && CUID_RE.test(value);
}

export async function POST(req: Request) {
  return withRateLimit(req, () =>
    withApiRequest(req, async () => {
      const auth = await verifyApiKey(req);
      if (auth instanceof NextResponse) return auth;

      setRequestAuth({
        teamId: auth.teamId,
        keyId: auth.keyId,
        scopeKind: auth.scopeKind,
      });

      // scan-scope keys cannot trigger — the scan doesn't exist yet, so there's
      // no scanId to constrain to. Return 405 so callers learn `scope_kind=scan`
      // is incompatible with /api/v1/webhooks/trigger.
      if (auth.scopeKind === 'scan') {
        return NextResponse.json(
          {
            code: 'scope_not_supported',
            message: 'scan-scope keys cannot trigger new scans',
          },
          { status: 405 },
        );
      }

      // Capture raw body before any parse — Next 16 reads the body once, so
      // `req.text()` and a subsequent `req.json()` would race on the same
      // stream. We hold the raw form for the HMAC verify and a parsed view
      // for the zod schema.
      const rawBody = await req.text();

      // HMAC unsigned path: pin-by-id. Missing/malformed `X-Webhook-Id` is
      // treated as unauthorized — same envelope the api-key gate returns so
      // SIEM consumers don't need a discriminator.
      const webhookIdHeader = req.headers.get(WEBHOOK_ID_HEADER);
      if (!isCuid(webhookIdHeader)) return unauthorized();

      const signature = req.headers.get(SIGNATURE_HEADER);
      if (!signature) return unauthorized();

      const inbound = await verifyInboundWebhook({
        rawBody,
        signatureHeader: signature,
        webhookId: webhookIdHeader,
        teamId: auth.teamId,
      });
      if (!inbound) return unauthorized();

      // Parse the JSON body now that the body has been consumed for HMAC.
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
      }

      const parsed = WebhookTriggerBody.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          { code: 'bad_request', issues: parsed.error.issues },
          { status: 400 },
        );
      }

      // Resolve target: prefer body.target, fall back to repository.url hostname.
      // Both routes must pass HOSTNAME_OR_IP (RFC1918/loopback blocked). If the
      // payload gives an explicit target that fails validation we reject the
      // request rather than silently fall through to repository.url — an explicit
      // wrong target is a misconfigured pipeline, not a fallback case.
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

      // Filter ports through the MVP allowlist (matches /api/scan's PORT_ALLOWLIST
      // union). Anything outside [22,80,443,8080,8443] is rejected with 400 — the
      // webhook payload accepts any 1..65535 from zod, then we narrow.
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

      // Pre-create a queued Scan row + the WebhookTrigger side-table row so
      // the 201 handshake row is visible on the Scans page immediately and
      // the workspace context is preserved for post-hoc audit. These stay
      // even if the background scan throws — both surfaces (Scans page +
      // WebhookTrigger look-up) read them.
      const queued = await prisma.scan.create({
        data: {
          target,
          mode,
          status: 'queued',
          startedAt,
          teamId: auth.teamId,
          source: 'ci-webhook',
        },
        select: { id: true, startedAt: true },
      });

      // The triggered caller is expected to send a repository.url; if they
      // didn't, synthesize one from the resolved target so the side-table
      // still has a row (the webhook handler route already requires the
      // HMAC, so storing a placeholder host isn't a regression).
      const repositoryUrl = parsed.data.repository?.url ?? `https://${target}/`;

      await prisma.webhookTrigger.create({
        data: {
          scanId: queued.id,
          teamId: auth.teamId,
          repositoryUrl,
          repositoryRef: parsed.data.repository?.ref ?? null,
          repositoryCommit: parsed.data.repository?.commit ?? null,
          buildId: parsed.data.build?.id ?? null,
          buildStatus: parsed.data.build?.status ?? null,
          buildBranch: parsed.data.build?.branch ?? null,
          webhookId: inbound.webhook.id,
          signatureAlgorithm: inbound.webhook.signingAlgorithm,
        },
      });

      const out = WebhookTriggerResponse.parse({
        id: queued.id,
        target,
        mode,
        status: 'queued',
        startedAt: queued.startedAt.toISOString(),
        finishedAt: null,
        teamId: auth.teamId,
        source: 'ci-webhook',
      });

      // Fire-and-forget the actual scan + the outbound signed deliveries.
      // The 201 has already been queued for send with the queued envelope;
      // the background chain flips the row to running → completed/failed,
      // then notifies the team's registered endpoints with the final
      // envelope. Errors never bubble up so a slow customer endpoint or a
      // scanner-probe failure cannot 502 the inbound handshake.
      void (async () => {
        let scanItem: Awaited<ReturnType<typeof runScan>> | null = null;
        try {
          scanItem = await runScan(
            { target, ports: portsCheck.data, mode },
            { teamId: auth.teamId, scanIdOverride: queued.id, source: 'ci-webhook' },
          );
        } catch {
          // Background scan error — leave the row at its inferred state
          // (running if the probe wrote assets, queued if the probe never
          // got that far) and don't try to mutate it from here. The Scans
          // page surfaces the truth. Failure of the background chain must
          // never bubble back into the inbound request handler.
          return;
        }

        const deliveryEnvelope = WebhookTriggerResponse.parse({
          id: scanItem.id,
          target: scanItem.target,
          mode: scanItem.mode,
          status: scanItem.status,
          startedAt: scanItem.startedAt,
          finishedAt: scanItem.finishedAt,
          teamId: auth.teamId,
          source: scanItem.source,
        });
        await deliverAfterScan(auth.teamId, deliveryEnvelope);
      })().catch(() => {
        /* swallowed — best-effort delivery */
      });

      return NextResponse.json(out, { status: 201 });
    }),
  );
}

// Fire-and-forget signed webhook deliveries for a completed scan.
// Looks up all active (non-revoked) webhooks for the team and POSTs the scan
// result payload to each. Errors are caught and never thrown so they cannot
// bubble into the parent request handler.
async function deliverAfterScan(
  teamId: string,
  payload: z.infer<typeof WebhookTriggerResponse>,
): Promise<void> {
  const webhooks = await prisma.webhook.findMany({
    where: { teamId, revokedAt: null },
    select: { id: true, url: true },
  });
  await Promise.allSettled(
    webhooks.map(async (wh) => {
      const secret = await getWebhookSigningSecret(wh.id, teamId);
      if (!secret) return; // decrypt failed — row was written with a different env key
      await deliverWebhook({ webhookId: wh.id, url: wh.url, secret, payload });
    }),
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
