// @polsia:user-owned
//
// Pure derivation of SOC 2 / HIPAA / NIST 800-53 control coverage from scan
// findings. NO `server-only`, NO prisma, NO fetch — importable from both the
// handler (server) and the client island. Determinism is the auditability
// claim; no AI/LLM tagging in this layer.
//
// Pass/fail semantics (card-relative):
//   passCount = static-universe controls with 0 findings tagged
//   failCount = unique controls referenced by ≥1 finding (deduped)
//   per-control `worstSeverity` = max severity among tagged findings
//
// Universe-relative N/A semantics (a control not in scope for this team)
// would need a separate compliance-control-universe data table — out of scope.
// Severity ordering matches src/lib/business/scanner/prioritize.ts.

export const COMPLIANCE_FRAMEWORKS = ['SOC2', 'HIPAA', 'NIST_800_53'] as const;
export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function severityRank(value: string | null): number {
  return SEVERITY_RANK[(value ?? '').toLowerCase()] ?? 0;
}

// Human-auditable section label per control ID; short enough for the table
// column, full enough for an auditor tooltip.
const TITLES: Record<ComplianceFramework, Record<string, string>> = {
  SOC2: {
    CC6_1: 'Logical access controls',
    CC6_2: 'User provisioning & removal',
    CC6_6: 'Threat protection',
    CC6_7: 'Data-in-transit protection',
    CC7_1: 'Detection of vulnerabilities',
    CC7_2: 'Anomaly & event monitoring',
    CC7_3: 'Incident analysis',
    CC7_4: 'Incident response',
  },
  HIPAA: {
    '164_308_a_1_ii_D': '§164.308(a)(1)(ii)(D) — system activity review',
    '164_308_a_8': '§164.308(a)(8) — evaluation',
    '164_312_a_1': '§164.312(a)(1) — access control',
    '164_312_a_2_iv': '§164.312(a)(2)(iv) — encryption / decryption',
    '164_312_c_1': '§164.312(c)(1) — integrity',
    '164_312_e_1': '§164.312(e)(1) — transmission security',
  },
  NIST_800_53: {
    'AC-3': 'AC-3 Access enforcement',
    'AC-17': 'AC-17 Remote access',
    'CM-7': 'CM-7 Least functionality',
    'CM-8': 'CM-8 System component inventory',
    'IA-5': 'IA-5 Authenticator management',
    'RA-5': 'RA-5 Vulnerability monitoring & scanning',
    'SC-8': 'SC-8 Transmission confidentiality & integrity',
    'SC-12': 'SC-12 Cryptographic key management',
    'SC-13': 'SC-13 Cryptographic protection',
    'SI-2': 'SI-2 Flaw remediation',
    'SI-7': 'SI-7 Software & information integrity',
    'SI-10': 'SI-10 Information input validation',
    'SI-15': 'SI-15 Code provenance',
    'SI-16': 'SI-16 Memory protection',
  },
};

interface KeywordRule {
  pattern: RegExp;
  minSeverity: 'critical' | 'high' | 'medium' | 'low' | 'any';
  tags: Record<ComplianceFramework, string[]>;
}

const RULES: KeywordRule[] = [
  {
    pattern: /tls|ssl|heartbleed|openssl/i,
    minSeverity: 'any',
    tags: {
      SOC2: ['CC6_1', 'CC6_7', 'CC7_1'],
      HIPAA: ['164_312_e_1'],
      NIST_800_53: ['SC-8', 'SC-13', 'SI-2'],
    },
  },
  {
    pattern: /ssh.*key|private.?key|agent|roam/i,
    minSeverity: 'high',
    tags: {
      SOC2: ['CC6_1', 'CC6_2', 'CC7_2'],
      HIPAA: ['164_312_a_2_iv'],
      NIST_800_53: ['AC-3', 'IA-5', 'SC-12'],
    },
  },
  {
    pattern: /auth.*bypass|rce|pkcs.?11|backdoor|unauthenticated/i,
    minSeverity: 'high',
    tags: {
      SOC2: ['CC6_1', 'CC6_6', 'CC7_3', 'CC7_4'],
      HIPAA: ['164_308_a_1_ii_D', '164_312_a_1', '164_312_c_1'],
      NIST_800_53: ['SI-10', 'SI-15', 'AC-17', 'CM-7'],
    },
  },
  {
    pattern: /buffer|heap|memory|asn\.?1|parse|overflow/i,
    minSeverity: 'high',
    tags: {
      SOC2: ['CC7_1', 'CC7_3'],
      HIPAA: ['164_312_c_1'],
      NIST_800_53: ['SI-10', 'SI-16', 'CM-7'],
    },
  },
  {
    pattern: /filesmatch|path.*bypass|filename.*bypass|newline/i,
    minSeverity: 'medium',
    tags: {
      SOC2: ['CC6_1', 'CC6_6'],
      HIPAA: ['164_308_a_1_ii_D'],
      NIST_800_53: ['AC-3', 'CM-7', 'SI-10'],
    },
  },
  {
    pattern: /banner|version.*disclosure|info.*disclose/i,
    minSeverity: 'low',
    tags: {
      SOC2: ['CC7_2'],
      HIPAA: [],
      NIST_800_53: ['CM-8', 'SI-7'],
    },
  },
];

const DEFAULT_RULE: KeywordRule = {
  pattern: /.*/,
  minSeverity: 'any',
  tags: {
    SOC2: ['CC7_3'],
    HIPAA: ['164_308_a_8'],
    NIST_800_53: ['SI-2', 'RA-5'],
  },
};

const SEVERITY_LABEL: Record<KeywordRule['minSeverity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  any: 'any',
};

function rankForMin(min: KeywordRule['minSeverity']): number {
  if (min === 'any') return 0;
  return SEVERITY_RANK[min] ?? 0;
}

function passes(rule: KeywordRule, severity: string | null): boolean {
  return severityRank(severity) >= rankForMin(rule.minSeverity);
}

function staticUniverse(framework: ComplianceFramework): string[] {
  const seen = new Set<string>();
  for (const rule of RULES) {
    for (const id of rule.tags[framework]) seen.add(id);
  }
  for (const id of DEFAULT_RULE.tags[framework]) seen.add(id);
  return [...seen].sort();
}

function descriptionText(f: FindingInput): string {
  return `${f.matchReason ?? ''}\n${f.description ?? ''}`;
}

function buildReason(rule: KeywordRule, finding: FindingInput): string {
  const raw = rule.pattern.source.replace(/^\(\?i\)/, '').replace(/\\\//g, '/');
  return `keyword "${raw}" matched; severity ${finding.severity ?? 'null'} ≥ ${SEVERITY_LABEL[rule.minSeverity]}`;
}

export interface ControlTag {
  framework: ComplianceFramework;
  controlId: string;
  reason: string;
}

export interface FindingInput {
  cveId: string;
  severity: string | null;
  matchReason: string | null;
  description?: string | null;
}

export interface ControlCoverage {
  controlId: string;
  title: string;
  failing: number;
  worstSeverity: string | null;
}

export interface FrameworkCoverage {
  framework: ComplianceFramework;
  totalFindings: number;
  passCount: number;
  failCount: number;
  controls: ControlCoverage[];
}

function titleFor(framework: ComplianceFramework, controlId: string): string {
  return TITLES[framework][controlId] ?? controlId;
}

function compareSeverity(a: string | null, b: string | null): number {
  return severityRank(a) - severityRank(b);
}

export function mapFindingToControls(f: FindingInput): ControlTag[] {
  const haystack = descriptionText(f);
  const tags: ControlTag[] = [];
  const seen = new Set<string>();

  for (const rule of [...RULES, DEFAULT_RULE]) {
    if (!passes(rule, f.severity)) continue;
    if (!rule.pattern.test(haystack)) continue;
    for (const framework of COMPLIANCE_FRAMEWORKS) {
      for (const controlId of rule.tags[framework]) {
        const key = `${framework}::${controlId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push({ framework, controlId, reason: buildReason(rule, f) });
      }
    }
  }
  return tags;
}

export function summarizeFrameworks(findings: FindingInput[]): FrameworkCoverage[] {
  const totalFindings = findings.length;
  return COMPLIANCE_FRAMEWORKS.map((framework) => {
    const statByControl = new Map<string, { count: number; worst: string | null }>();

    for (const f of findings) {
      const tags = mapFindingToControls(f).filter((t) => t.framework === framework);
      for (const t of tags) {
        const cur = statByControl.get(t.controlId) ?? { count: 0, worst: null };
        cur.count += 1;
        if (compareSeverity(f.severity, cur.worst) > 0) cur.worst = f.severity;
        statByControl.set(t.controlId, cur);
      }
    }

    const universe = staticUniverse(framework);
    const controls: ControlCoverage[] = universe.map((controlId) => {
      const stat = statByControl.get(controlId);
      return {
        controlId,
        title: titleFor(framework, controlId),
        failing: stat?.count ?? 0,
        worstSeverity: stat?.worst ?? null,
      };
    });
    const failCount = controls.filter((c) => c.failing > 0).length;
    const passCount = controls.length - failCount;

    return {
      framework,
      totalFindings,
      passCount,
      failCount,
      controls,
    };
  });
}
