// @polsia:user-owned — `loadAssetRemediationTimeline(teamId, host)`
// for GET /api/assets/<host>/remediation-timeline. Server-only:
// imports `server-only` + prisma. The route layer at
// src/app/api/assets/[host]/remediation-timeline/route.ts is the
// ONLY caller; never called from a Server Component, page body, or
// layout (data-plane rule).
//
// Strategy: ONE `prisma.alert.findMany` scoped to
// `(teamId, finding.asset.host, OR remediatedAt IS NOT NULL OR
// (closedAt IS NOT NULL AND status='resolved'))`. Narrow select
// keeps the wire move cheap. `take: MAX_EVENTS` caps the response
// so a noisy host doesn't drive a multi-MB envelope.
//
// Dedupe posture: ONE-stamp-per-alertId. If BOTH `remediatedAt`
// and `closedAt` are stamped on the same row, `remediatedAt` always
// wins. Source discriminator emitted on the wire so the UI can
// label the dot without a second read.
//
// Peer-read posture for CVE titles: same `batchFetchAlert
// VulnerabilityTitles` helper the /api/alerts and /api/alerts/
// export.csv routes already use (mirrors the cached best-effort
// join documented at src/lib/business/alerts-search.ts). A
// CveEntry miss lands as `null` on the wire so the client's
// `RemediationEvent.cveTitle` stays nullable.

import 'server-only';
import { batchFetchAlertVulnerabilityTitles } from '@/lib/business/alerts-search';
import {
  RemediationTimeline,
  type RemediationTimeline as RemediationTimelineData,
} from '@/lib/contracts/assets-remediation';
import { prisma } from '@/lib/db';

const MAX_EVENTS = 500;

// Bucket a free-form `Alert.severity` to the canonical lower-case
// tier literal. Verbatim copy of the equivalent helper at
// src/lib/business/assets-detail.ts — keeping the duplication rather
// than lifting it into a shared module because a follow-up cleanup
// pass is already pending and the existing posture is dual-local.
function normalizeSeverity(
  value: string | null | undefined,
): 'critical' | 'high' | 'medium' | 'low' | null {
  const key = (value ?? '').toLowerCase();
  if (key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  if (key === 'low') return 'low';
  return null;
}

export async function loadAssetRemediationTimeline(
  teamId: string,
  host: string,
): Promise<RemediationTimelineData> {
  const rows = await prisma.alert.findMany({
    where: {
      teamId,
      finding: { asset: { host } },
      OR: [
        { remediatedAt: { not: null } },
        { closedAt: { not: null }, status: 'resolved' as const },
      ],
    },
    orderBy: [{ remediatedAt: 'desc' }, { closedAt: 'desc' }],
    take: MAX_EVENTS,
    select: {
      id: true,
      severity: true,
      status: true,
      remediatedAt: true,
      closedAt: true,
      finding: { select: { cveId: true } },
    },
  });

  // Dedupe / pick the most informative stamp per alert:
  //   - If `remediatedAt` is set → use `remediatedAt`, source='remediated'.
  //   - Else if `closedAt` is set AND status='resolved' → use
  //     `closedAt`, source='resolved'.
  // The 'resolved' literal source is meaningful to the operator:
  // "resolved by the team workflow" vs "manually stamped as
  // remediated".
  //
  // Dedupe is by `alertId`: the strict if/else-if pick can never
  // emit two events for the same alert (the OR-clause filters
  // upstream, then we pick ONE stamp per row).
  interface Candidate {
    alertId: string;
    cveId: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | null;
    resolvedAt: Date;
    source: 'remediated' | 'resolved';
  }
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.remediatedAt) {
      unique.push({
        alertId: r.id,
        cveId: r.finding?.cveId ?? '',
        severity: normalizeSeverity(r.severity),
        resolvedAt: r.remediatedAt,
        source: 'remediated',
      });
    } else if (r.closedAt && r.status === 'resolved') {
      unique.push({
        alertId: r.id,
        cveId: r.finding?.cveId ?? '',
        severity: normalizeSeverity(r.severity),
        resolvedAt: r.closedAt,
        source: 'resolved',
      });
    }
  }

  // Peer-read CVE titles (best-effort). Empty result here is fine —
  // the map's default is `null` for every cveId, and the wire simply
  // emits `cveTitle: null` so the client's nullable contract stays
  // intact.
  const titleByCveId = await batchFetchAlertVulnerabilityTitles(unique.map((e) => e.cveId));

  // ASC by resolvedAt for the chart render (oldest → newest, dots
  // mounted left-to-right).
  unique.sort((a, b) => a.resolvedAt.getTime() - b.resolvedAt.getTime());

  const events = unique.map((e) => ({
    alertId: e.alertId,
    cveId: e.cveId,
    cveTitle: titleByCveId.get(e.cveId) ?? null,
    severity: e.severity,
    resolvedAt: e.resolvedAt.toISOString(),
    source: e.source,
  }));

  return RemediationTimeline.parse({
    host,
    events,
    rangeStart: events.length > 0 ? (events[0]?.resolvedAt ?? null) : null,
    rangeEnd: events.length > 0 ? (events[events.length - 1]?.resolvedAt ?? null) : null,
  });
}
