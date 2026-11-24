// @polsia:user-owned — zod contract for the /api/v1/** enterprise REST API.
// Imported only from the two v1 route handlers; pure zod declarations so the
// shapes can be parsed server-side and validated client-side via @/lib/api-
// client's schema option. No server-only imports here.

import { z } from 'zod';
import { ScanSourceEnum } from '@/lib/contracts/scan';

// ===================== SHARED PIECES =====================

// Mirror of scan status values persisted by src/app/api/scan/route.ts and
// src/lib/contracts/scan.ts — kept as a literal union so a route contract
// drift surfaces as a parse error rather than a silent cast.
export const ScanStatus = z.enum(['queued', 'running', 'completed', 'failed']);

export const EnterpriseScanHeader = z.object({
  id: z.string(),
  target: z.string(),
  mode: z.string(),
  status: ScanStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  // Owning team id (carries the per-scan ownership so SIEM consumers can
  // correlate). Null on legacy scans not yet attributed to a team.
  teamId: z.string().nullable(),
  // Origin marker for the scan — lets SIEM consumers distinguish CI-driven
  // scans from scheduled / manual ones without a follow-up lookup. Same
  // vocabulary as ScanSourceEnum in src/lib/contracts/scan.ts.
  source: ScanSourceEnum,
});

// Slimmer asset projection than ScanItem.asset — drops the probe-only fields
// (protocol, state, latencyMs) that SIEMs/dashboards do not consume, keeps the
// fields they correlate on (host, ip, port, banner, serviceHint).
export const EnterpriseMatchedAsset = z.object({
  id: z.string(),
  host: z.string(),
  ip: z.string(),
  port: z.number().int(),
  serviceHint: z.string().nullable(),
  banner: z.string().nullable(),
});

// Verbatim shape of @/lib/business/scanner/cve-remediation RemdiationEntry.
// Re-declared here (not re-exported from there) because cve-remediation.ts is
// plain TS, not zod — keeping the contract one-symbol deep means client islands
// can pull from a single import.
export const EnterpriseRemediation = z.object({
  recommendedFix: z.string(),
  fixVersionOrPatch: z.string().nullable(),
  verificationStep: z.string(),
  references: z.array(z.string()),
});

export const EnterpriseFinding = z.object({
  cveId: z.string(),
  severity: z.string().nullable(),
  cvssScore: z.number().nullable(),
  epssScore: z.number().nullable(),
  epssPercentile: z.number().nullable(),
  priorityScore: z.number().nullable(),
  kevListed: z.boolean().optional(),
  kevListedAt: z.string().nullable().optional(),
  // Live-intel fields (additive — existing SIEM consumers ignore them).
  vulncheckListed: z.boolean().optional(),
  vulncheckObservedAt: z.string().nullable().optional(),
  lastRescoreAt: z.string().nullable().optional(),
  rescoreSource: z.string().nullable().optional(),
  matchReason: z.string(),
  asset: EnterpriseMatchedAsset,
  remediation: EnterpriseRemediation,
});

// ===================== ENDPOINT ENVELOPES =====================

// GET /api/v1/scans — list scans, header envelope per item; total reflects the
// full result set, not the page size, so SIEM polls can paginate.
export const EnterpriseScanListResponse = z.object({
  items: z.array(EnterpriseScanHeader),
  limit: z.number().int().positive(),
  offset: z.number().int().min(0),
  total: z.number().int().min(0),
});

// GET /api/v1/scans/:id/findings — flat findings list sorted by the shared
// compareFindings comparator (priority desc -> cvss desc -> severity rank desc
// -> cveId asc), sliced AFTER sort for stable pagination.
export const EnterpriseScanFindingsResponse = z.object({
  scan: EnterpriseScanHeader,
  findings: z.array(EnterpriseFinding),
  limit: z.number().int().positive(),
  offset: z.number().int().min(0),
  total: z.number().int().min(0),
});

export type ScanStatus = z.infer<typeof ScanStatus>;
export type EnterpriseScanHeader = z.infer<typeof EnterpriseScanHeader>;
export type EnterpriseMatchedAsset = z.infer<typeof EnterpriseMatchedAsset>;
export type EnterpriseRemediation = z.infer<typeof EnterpriseRemediation>;
export type EnterpriseFinding = z.infer<typeof EnterpriseFinding>;
export type EnterpriseScanListResponse = z.infer<typeof EnterpriseScanListResponse>;
export type EnterpriseScanFindingsResponse = z.infer<typeof EnterpriseScanFindingsResponse>;

// ===================== CI/CD WEBHOOK INTAKE =====================
// POST /api/v1/webhooks/trigger — accepts a CI/CD-shaped payload from build
// pipelines (target OR repository.url, optional ports/mode/build context) and
// synchronously runs a scan through the existing orchestrator, returning a
// compact scan header the caller polls via /api/v1/scans/[id]/findings.
// Shape intentionally strict (.strict()) so a CI payload that has an unknown
// top-level key is rejected — keeps surface area auditable.

// Reuse ScanMode's shape (z.literal('tcp-only')) so this route and /api/scan
// agree on the only supported mode without forking the contract.
const WebhookMode = z.literal('tcp-only');

const WebhookRepository = z
  .object({
    url: z.string().url(),
    ref: z.string().optional(),
    commit: z.string().optional(),
  })
  .strict();

const WebhookBuild = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    branch: z.string().optional(),
  })
  .strict();

export const WebhookTriggerBody = z
  .object({
    target: z.string().optional(),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).max(5).optional(),
    repository: WebhookRepository.optional(),
    build: WebhookBuild.optional(),
    mode: WebhookMode.optional(),
  })
  .strict();

export const WebhookTriggerResponse = z.object({
  id: z.string().min(1),
  target: z.string(),
  mode: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  // String-typed to mirror EnterpriseScanHeader (and src/lib/contracts/scan
  // ScanItem) so the post-runScan parse round-trips without coercion. The
  // wire value is always an ISO-8601 string from runScan's .toISOString().
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  teamId: z.string().nullable(),
  source: ScanSourceEnum,
});

export type WebhookTriggerBody = z.infer<typeof WebhookTriggerBody>;
export type WebhookTriggerBodyInput = z.input<typeof WebhookTriggerBody>;
export type WebhookTriggerResponse = z.infer<typeof WebhookTriggerResponse>;

// ===================== CI/CD SCAN TRIGGER (summary response) =====================
// POST /api/v1/scan — companion endpoint to /webhooks/trigger. Same request
// body shape (reuses WebhookTriggerBody), but the response is the verdict
// summary a CI/CD pipeline writes back to the PR comment instead of an
// out-of-band poll. The poll URLs point at /api/v1/scans/{id} and its
// findings endpoint so a CI step that wants the full list can drop in.

export const SeveritySummary = z.object({
  critical: z.number().int().min(0),
  high: z.number().int().min(0),
  medium: z.number().int().min(0),
  low: z.number().int().min(0),
  total: z.number().int().min(0),
});

// Capped at 10 — the top-N of the CRITICAL bucket — so the JSON body stays
// small enough to drop into a single-line PR comment. Full results stay
// reachable via poll.findingsUrl.
export const CriticalFinding = z.object({
  cveId: z.string(),
  severity: z.string(),
  priorityScore: z.number().nullable(),
  asset: EnterpriseMatchedAsset,
  remediation: EnterpriseRemediation,
});

export const ScanTriggerSummaryResponse = z.object({
  id: z.string().min(1),
  target: z.string(),
  mode: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  teamId: z.string().nullable(),
  source: ScanSourceEnum,
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  summary: SeveritySummary,
  criticalFindings: z.array(CriticalFinding).max(10),
  poll: z.object({
    scanUrl: z.string(),
    findingsUrl: z.string(),
  }),
});

export type SeveritySummary = z.infer<typeof SeveritySummary>;
export type CriticalFinding = z.infer<typeof CriticalFinding>;
export type ScanTriggerSummaryResponse = z.infer<typeof ScanTriggerSummaryResponse>;
