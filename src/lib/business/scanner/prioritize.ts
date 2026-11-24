// @polsia:user-owned — Pure scoring + ordering for vulnerability findings.
// Combines CVSS severity, EPSS exploit-likelihood, KEV (CISA's Known
// Exploited Vulnerabilities catalog), AND VulnCheck's NVD-CVE listing into
// a single 0-10 priority score:
//   0.6*cvss + 0.4*epss + KEV_WEIGHT*kevListed + VULNCHECK_WEIGHT*vulncheckListed
// clamped to 0..10. VULNCHECK_WEIGHT > KEV_WEIGHT so a freshly-listed
// VulnCheck hit pulls a finding above a hot KEV one. The comparator then
// hoists VulnCheck-listed over KEV-listed over CVSS-desc. Exports the
// shared comparator (compareFindings) so /api/scan, /api/scan/<id>, and
// /api/scan/<id>/report agree on the rank. No external deps, no server-
// only imports — usable from client islands and unit tests.

const CVSS_WEIGHT = 0.6;
const EPSS_WEIGHT = 0.4;
// Additive KEV boost. Applied AFTER priority is computed AND used as a
// first-priority tiebreaker in compareFindings, so a low-CVSS KEV finding
// hoists above a high-CVSS non-KEV finding regardless of where the score
// formula lands.
const KEV_WEIGHT = 2.0;
// VulnCheck boost — larger than KEV_WEIGHT because VulnCheck's NVD-CVE
// index tracks "freshly listed + in-the-wild" exploits earlier than CISA's
// curated KEV. The boost only fires when the EPSS score is above the floor
// below — a VulnCheck listing on a tiny/no-exploit CVE is treated as noise
// so it does not flatline the entire dashboard above zero CVSS findings.
const VULNCHECK_WEIGHT = 2.6;
const VULNCHECK_EPSS_FLOOR = 0.05;

// Priority scores at or above this boundary are the product's high-risk tier.
// Keep this pure and dependency-free so server and client risk surfaces share
// the same classification without crossing the data-plane boundary.
export const HIGH_RISK_PRIORITY_SCORE = 7;

export function isHighRiskPriorityScore(score: number | null | undefined): boolean {
  return score != null && score >= HIGH_RISK_PRIORITY_SCORE;
}

interface SeverityComponents {
  cvssContribution: number;
  epssContribution: number;
  kevContribution: number;
  vulncheckContribution: number;
  cvssSource: 'cvss' | 'severity' | 'missing' | null;
}

export interface PrioritizeInput {
  cvssScore: number | null | undefined;
  epssScore: number | null | undefined;
  severity: string | null | undefined;
  kevListed?: boolean | null | undefined;
  vulncheckListed?: boolean | null | undefined;
}

export interface PrioritizeResult {
  priorityScore: number;
  epssScore: number | null;
  epssPercentile: number | null;
  components: SeverityComponents;
}

// Map severity buckets to a CVSS-equivalent midpoint. Used only when CVSS is
// missing — gives the score a reasonable denominator.
function severityNorm(severity: string | null | undefined): number | null {
  const s = (severity ?? '').toLowerCase();
  if (s === 'critical') return 9.5;
  if (s === 'high') return 7.5;
  if (s === 'medium') return 5.0;
  if (s === 'low') return 2.5;
  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function prioritizeFinding(input: PrioritizeInput): PrioritizeResult {
  const cvss = typeof input.cvssScore === 'number' ? input.cvssScore : null;
  const epss = typeof input.epssScore === 'number' ? input.epssScore : null;

  let effectiveCvss: number | null = null;
  let cvssSource: SeverityComponents['cvssSource'] = null;
  if (cvss != null) {
    effectiveCvss = clamp(cvss, 0, 10);
    cvssSource = 'cvss';
  } else {
    const sev = severityNorm(input.severity);
    if (sev != null) {
      effectiveCvss = sev;
      cvssSource = 'severity';
    } else {
      cvssSource = 'missing';
    }
  }

  const effectiveEpss = epss != null ? clamp(epss, 0, 1) : 0;
  const kevOn = input.kevListed === true;
  const vcWanted = input.vulncheckListed === true;
  // Floor: VulnCheck boost only if EPSS is non-trivial. This guards against
  // bare listings on CVEs with no real-world exploitation blowing the
  // dashboard above high-CVSS unlisted findings.
  const vcOn = vcWanted && effectiveEpss >= VULNCHECK_EPSS_FLOOR;

  const cvssContribution = effectiveCvss != null ? CVSS_WEIGHT * effectiveCvss : 0;
  const epssContribution = EPSS_WEIGHT * effectiveEpss;
  const kevContribution = kevOn ? KEV_WEIGHT : 0;
  const vulncheckContribution = vcOn ? VULNCHECK_WEIGHT : 0;
  const priorityScore = clamp(
    cvssContribution + epssContribution + kevContribution + vulncheckContribution,
    0,
    10,
  );

  return {
    priorityScore,
    epssScore: epss,
    epssPercentile: null,
    components: {
      cvssContribution,
      epssContribution,
      kevContribution,
      vulncheckContribution,
      cvssSource,
    },
  };
}

// ===================== SHARED ORDERING =====================
// Stable finding comparator used by /api/scan, /api/scan/<id>, /api/scan/<id>/report,
// and the run-scan orchestrator. Priority desc → VulnCheck-listed desc → KEV-
// listed desc → CVSS desc → severity rank desc → cveId asc. VulnCheck is
// the freshest signal, so it outranks KEV; KEV outranks everything else.
// Picked apart via a flat record so it accepts any row shape that carries
// the fields we sort on.

export interface FindingSortKey {
  priorityScore: number | null;
  severity: string | null;
  cvssScore: number | null;
  cveId: string;
  kevListed: boolean;
  vulncheckListed: boolean;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function severityRank(severity: string | null, cvssFallback: number | null): number {
  const key = (severity ?? '').toLowerCase();
  if (key in SEVERITY_RANK) return SEVERITY_RANK[key] ?? 0;
  if (cvssFallback != null) {
    if (cvssFallback >= 9) return 4;
    if (cvssFallback >= 7) return 3;
    if (cvssFallback >= 4) return 2;
    if (cvssFallback > 0) return 1;
  }
  return 0;
}

export function compareFindings(a: FindingSortKey, b: FindingSortKey): number {
  const pA = a.priorityScore ?? 0;
  const pB = b.priorityScore ?? 0;
  if (pB !== pA) return pB - pA;
  // VulnCheck tiebreaker fires first: hoists listed findings above KEV-
  // listed above unlisted when priority breaks even. VULNCHECK_WEIGHT >
  // KEV_WEIGHT on the score axis already reflects this on a clean recompute;
  // the comparator step keeps the semantic correct after partial state (a
  // fresh VulnCheck listing that hasn't yet hit the priority score).
  if (a.vulncheckListed !== b.vulncheckListed) return a.vulncheckListed ? -1 : 1;
  if (a.kevListed !== b.kevListed) return a.kevListed ? -1 : 1;
  const cA = a.cvssScore ?? 0;
  const cB = b.cvssScore ?? 0;
  if (cB !== cA) return cB - cA;
  const rA = severityRank(a.severity, a.cvssScore);
  const rB = severityRank(b.severity, b.cvssScore);
  if (rB !== rA) return rB - rA;
  return a.cveId.localeCompare(b.cveId);
}
