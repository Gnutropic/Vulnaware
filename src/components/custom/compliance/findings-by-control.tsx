// @polsia:user-owned — Findings grouped-by-control table. Pure presentational;
// receives the filter state and the parsed payload from the page level.

'use client';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  ComplianceFramework,
  FindingWithControls as FindingWithControlsData,
} from '@/lib/contracts/compliance';

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-destructive text-destructive-foreground',
  high: 'bg-destructive/85 text-destructive-foreground',
  medium: 'bg-amber-500 text-white dark:bg-amber-500/90',
  low: 'bg-blue-500 text-white dark:bg-blue-500/90',
};

function severityClass(severity: string | null): string {
  if (!severity) return 'border border-border bg-muted text-muted-foreground';
  return SEVERITY_CLASS[severity.toLowerCase()] ?? 'border border-border bg-muted text-foreground';
}

interface FindingsByControlProps {
  findings: FindingWithControlsData[];
  framework: ComplianceFramework;
  severityFilter: string;
  controlQuery: string;
}

interface ControlGroup {
  controlId: string;
  findings: FindingWithControlsData[];
  worstSeverity: string | null;
}

function severityRank(value: string | null): number {
  const key = (value ?? '').toLowerCase();
  if (key === 'critical') return 4;
  if (key === 'high') return 3;
  if (key === 'medium') return 2;
  if (key === 'low') return 1;
  return 0;
}

export function FindingsByControl({
  findings,
  framework,
  severityFilter,
  controlQuery,
}: FindingsByControlProps) {
  const groups = useMemo<ControlGroup[]>(() => {
    const filterSeverity = (severityFilter ?? 'all').toLowerCase();
    const q = controlQuery.trim().toLowerCase();
    const map = new Map<string, FindingWithControlsData[]>();
    for (const f of findings) {
      if (filterSeverity !== 'all' && (f.severity ?? '').toLowerCase() !== filterSeverity) {
        continue;
      }
      for (const tag of f.tags) {
        if (tag.framework !== framework) continue;
        if (q && !tag.controlId.toLowerCase().includes(q)) continue;
        const list = map.get(tag.controlId) ?? [];
        list.push(f);
        map.set(tag.controlId, list);
      }
    }
    return [...map.entries()]
      .map(([controlId, list]) => ({
        controlId,
        findings: list,
        worstSeverity: list.reduce<string | null>(
          (acc, f) => (severityRank(f.severity) > severityRank(acc) ? f.severity : acc),
          null,
        ),
      }))
      .sort((a, b) => {
        const r = severityRank(b.worstSeverity) - severityRank(a.worstSeverity);
        if (r !== 0) return r;
        return a.controlId.localeCompare(b.controlId);
      });
  }, [findings, framework, severityFilter, controlQuery]);

  if (groups.length === 0) {
    return (
      <Card className="border-dashed border-border bg-card">
        <CardHeader>
          <CardTitle className="font-display text-h3 text-foreground">
            No findings match these filters
          </CardTitle>
          <CardDescription>
            Try a different framework, severity, or control id. Zero findings means zero failing
            controls in this framework — a passing result.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader>
        <CardTitle className="font-display text-h3 text-foreground">
          Findings grouped by control
        </CardTitle>
        <CardDescription>
          Each row is a control ID. The accordion shows the findings tagged against it, with the
          rule-driven reason auditors can trace back to the keyword and severity gate.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Accordion type="multiple" className="border-t border-border">
          {groups.map((group) => (
            <AccordionItem key={group.controlId} value={group.controlId} className="border-b">
              <AccordionTrigger className="px-6 py-4">
                <span className="flex items-center gap-3">
                  <span className="font-mono text-body text-foreground">{group.controlId}</span>
                  <Badge className={severityClass(group.worstSeverity)}>
                    {group.worstSeverity ?? 'No severity'}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-caption">
                    {group.findings.length} finding{group.findings.length === 1 ? '' : 's'}
                  </Badge>
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6">
                <ul className="flex flex-col gap-3 pb-2">
                  {group.findings.map((f) => (
                    <li
                      key={`${f.cveId}|${f.scanId}|${f.severity ?? ''}|${f.matchReason}`}
                      className="rounded-[var(--radius-lg)] border border-border bg-background p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-body text-foreground">{f.cveId}</span>
                        <Badge className={severityClass(f.severity)}>
                          {f.severity ?? 'No severity'}
                        </Badge>
                      </div>
                      <p className="mt-2 text-body text-muted-foreground">{f.matchReason}</p>
                      <div className="mt-2 flex flex-col gap-1 text-caption text-muted-foreground">
                        <span>
                          Scanned:{' '}
                          <Link
                            href={`/scans/${f.scanId}`}
                            className="font-mono underline-offset-2 hover:underline"
                          >
                            {f.scanTarget}
                          </Link>{' '}
                          · {new Date(f.scanStartedAt).toLocaleString()}
                        </span>
                        <span className="text-foreground">
                          <ShieldAlert
                            aria-hidden="true"
                            className="mr-1 inline size-3.5 text-brand-500"
                          />
                          {(() => {
                            const tag = f.tags.find(
                              (t) => t.framework === framework && t.controlId === group.controlId,
                            );
                            return tag?.reason ?? 'Tagged by control mapper';
                          })()}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  );
}
