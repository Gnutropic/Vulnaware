// @polsia:user-owned — Shared zod contract for the compliance coverage resource.
// Imported by the /api/compliance route handler AND the client island; keep
// this module client-importable (zod only, no server-only imports).

import { z } from 'zod';
import { COMPLIANCE_FRAMEWORKS } from '@/lib/business/compliance/framework-mapper';

export const ComplianceFramework = z.enum(COMPLIANCE_FRAMEWORKS);

export const ControlCoverage = z.object({
  controlId: z.string(),
  title: z.string(),
  failing: z.number().int().min(0),
  worstSeverity: z.string().nullable(),
});

export const FrameworkCoverage = z.object({
  framework: ComplianceFramework,
  totalFindings: z.number().int().min(0),
  passCount: z.number().int().min(0),
  failCount: z.number().int().min(0),
  controls: z.array(ControlCoverage),
});

// Per-finding payload consumed by the findings-by-control table: includes
// the control tags that matched so the right-pane can render the auditable
// reason text per row.
export const FindingWithControls = z.object({
  cveId: z.string(),
  severity: z.string().nullable(),
  matchReason: z.string(),
  scanId: z.string(),
  scanTarget: z.string(),
  scanStartedAt: z.string(),
  tags: z.array(
    z.object({
      framework: ComplianceFramework,
      controlId: z.string(),
      reason: z.string(),
    }),
  ),
});

export const ComplianceFindings = z.object({
  items: z.array(FindingWithControls),
});

export const ComplianceList = z.object({
  frameCount: z.number().int().min(0),
  scannedAt: z.string(),
  scansAnalyzed: z.number().int().min(0),
  items: z.array(FrameworkCoverage),
  findings: ComplianceFindings,
});

export type ComplianceFramework = z.infer<typeof ComplianceFramework>;
export type ControlCoverage = z.infer<typeof ControlCoverage>;
export type FrameworkCoverage = z.infer<typeof FrameworkCoverage>;
export type FindingWithControls = z.infer<typeof FindingWithControls>;
export type ComplianceFindings = z.infer<typeof ComplianceFindings>;
export type ComplianceList = z.infer<typeof ComplianceList>;
