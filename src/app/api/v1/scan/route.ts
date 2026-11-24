// @polsia:user-owned — CI/CD scan trigger that returns a verdict-pruned
// summary response for direct drop-in to a PR comment. Sibling of
// /api/v1/webhooks/trigger — same request shape, different response shape.
// The webhook-intake path remains untouched for backward compat with
// integrators that already poll /api/v1/scans/{id}/findings.
//
// Auth, scope-guard, body parsing, target resolution, port allowlist, and
// the synchronous runScan call are mirrored from
// src/app/api/v1/webhooks/trigger/route.ts so a misconfigured CI caller
// gets the same posture (401/503/405/400/502). The response diverges: it
// composes a verdict + summary counts + a top-N list of CRITICAL findings
// suitable for `$GITHUB_STEP_SUMMARY`, plus the same two `poll.*` URLs
// so a CI step that needs the full result can chain into the existing
// findings endpoint.

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-auth';
import { lookupRemediation } from '@/lib/business/scanner/cve-remediation';
import { compareFindings } from '@/lib/business/scanner/prioritize';
import { runScan } from '@/lib/business/scanner/run-scan';
import { deliverWebhook, getWebhookSigningSecret } from '@/lib/business/webhooks';
import { HOSTNAME_OR_IP, PORT_ALLOWLIST } from '@/lib/contracts/scan';
import {
  CriticalFinding,
  EnterpriseMatchedAsset,
  ScanTriggerSummaryResponse,
  type ScanTriggerSummaryResponse as ScanTriggerSummaryResponseT,
  WebhookTriggerBody,
} from '@/lib/contracts/scan-api';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const DEFAULT_PORTS: ReadonlyArray<22 | 80 | 443 | 8080 | 8443> = [443];

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

// Normalize a severity string ("High"/"CRITICAL"/"low") into the canonical
// lowercase bucket name. Anything outside the four-bucket set folds into
// `low` so an unknown severity from a non-NVD source can't blow the
// coverage the verdict depends on.
function severityBucket(value: string | null): 'critical' | 'high' | 'medium' | 'low' {
  const key = (value ?? '').toLowerCase();
  if (key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  return 'low';
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

      if (auth.scopeKind === 'scan') {
        return NextResponse.json(
          {
            code: 'scope_not_supported',
            message: 'scan-scope keys cannot trigger new scans',
          },
          { status: 405 },
        );
      }

      let json: unknown;
      try {
        json = await req.json();
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

      try {
        const scanItem = await runScan(
          {
            target,
            ports: portsCheck.data,
            mode: parsed.data.mode ?? 'tcp-only',
          },
          { teamId: auth.teamId, source: 'ci-webhook' },
        );

        // Indexing one-shot to keep the bucket math and the top-N join O(n).
        const assetsById = new Map(scanItem.assets.map((a) => [a.id, a]));
        const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
        type SortKey = Parameters<typeof compareFindings>[0];
        const sortable: Array<{ sortKey: SortKey; cveId: string; severity: string }> = [];

        for (const finding of scanItem.findings) {
          summary.total += 1;
          summary[severityBucket(finding.severity)] += 1;
          sortable.push({
            sortKey: {
              priorityScore: finding.priorityScore ?? null,
              severity: finding.severity ?? null,
              cvssScore: null,
              cveId: finding.cveId,
              kevListed: finding.kevListed === true,
              vulncheckListed: finding.vulncheckListed === true,
            },
            cveId: finding.cveId,
            severity: finding.severity ?? '',
          });
        }

        sortable.sort((a, b) => compareFindings(a.sortKey, b.sortKey));
        const top10 = sortable.slice(0, 10);

        const criticalFindings = top10
          .filter((row) => severityBucket(row.severity) === 'critical')
          .map((row) => {
            // Find the asset that this finding was matched against. Match by
            // (cveId, assetId-resolvable-from-the-finding) — sortables were
            // derived from the runScan findings; we look the actual asset up
            // here so the summary ships a rich asset + remediation projection.
            const source = scanItem.findings.find((f) => f.cveId === row.cveId);
            const asset = source ? (assetsById.get(source.assetId) ?? null) : null;
            if (!asset) return null;
            const remediation = lookupRemediation(row.cveId);
            return CriticalFinding.parse({
              cveId: row.cveId,
              severity: row.severity,
              priorityScore: row.sortKey.priorityScore,
              asset: EnterpriseMatchedAsset.parse({
                id: asset.id,
                host: asset.host,
                ip: asset.ip,
                port: asset.port,
                serviceHint: asset.serviceHint,
                banner: asset.banner,
              }),
              remediation,
            });
          })
          .filter((x): x is NonNullable<typeof x> => x != null);

        const verdict: 'pass' | 'fail' | 'inconclusive' =
          scanItem.status !== 'completed' ? 'inconclusive' : summary.critical > 0 ? 'fail' : 'pass';

        const out = ScanTriggerSummaryResponse.parse({
          id: scanItem.id,
          target: scanItem.target,
          mode: scanItem.mode,
          status: scanItem.status,
          startedAt: scanItem.startedAt,
          finishedAt: scanItem.finishedAt,
          teamId: auth.teamId,
          source: scanItem.source,
          verdict,
          summary,
          criticalFindings,
          poll: {
            scanUrl: `/api/v1/scans/${scanItem.id}`,
            findingsUrl: `/api/v1/scans/${scanItem.id}/findings`,
          },
        });

        void deliverAfterScan(auth.teamId, out).catch(() => {
          /* logged by deliverWebhook */
        });

        return NextResponse.json(out, { status: 201 });
      } catch (err) {
        return NextResponse.json(
          { code: 'scan_failed', message: err instanceof Error ? err.message : 'scan failed' },
          { status: 502 },
        );
      }
    }),
  );
}

// Fire-and-forget signed webhook deliveries for a completed scan. Uses
// `unknown` payload typing on the delivey side so the wider summary shape
// rides the same outbound pipeline as the compact WebhookTriggerResponse;
// `deliverWebhook` JSON-serializes whatever is passed in.
async function deliverAfterScan(
  teamId: string,
  payload: ScanTriggerSummaryResponseT,
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
