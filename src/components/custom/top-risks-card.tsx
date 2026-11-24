// @polsia:user-owned — Top 5 Risks card. Surfaces the highest-priority
// vulnerability findings of a scan with their priority score + EPSS exploit
// probability. Pure presentational; assumes `findings` is already sorted
// priority-desc by the server (run-scan orchestrator + GET sort handlers do
// this). Composes off Card + Badge; no data fetching here.

'use client';

import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { isHighRiskPriorityScore } from '@/lib/business/scanner/prioritize';
import type { VulnerabilityFindingItem } from '@/lib/contracts/scan';
import { cn } from '@/lib/utils';

const TOP_RISK_LIMIT = 5;

function severityVariant(sev: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical') return 'destructive';
  if (s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  if (s === 'low') return 'outline';
  return 'outline';
}

function scoreTone(score: number | null): string {
  if (isHighRiskPriorityScore(score)) return 'text-destructive';
  if (score == null) return 'text-muted-foreground';
  if (score >= 4) return 'text-amber-600 dark:text-amber-400';
  return 'text-muted-foreground';
}

function formatPercent(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return 'n/a';
  return `${(p * 100).toFixed(1)}%`;
}

function formatScore(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return 'n/a';
  return s.toFixed(2);
}

export function TopRisksCard({ findings }: { findings: VulnerabilityFindingItem[] }) {
  // Defensive slice: server already sorts priority-desc, but never trust
  // that invariant across all future producers.
  const top = [...findings].slice(0, TOP_RISK_LIMIT);

  return (
    <Card className="overflow-hidden border-brand-500/40 bg-gradient-to-br from-brand-500/[0.06] via-card to-card shadow-brand">
      <CardHeader className="border-b border-border/60 bg-card/60 backdrop-blur-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-eyebrow text-brand-600 dark:text-brand-300">
              <ShieldAlert className="size-3.5" aria-hidden /> Top risks
            </p>
            <CardTitle className="mt-2 font-display text-h3 text-foreground">
              Highest-priority findings
            </CardTitle>
            <CardDescription className="mt-1 text-caption text-muted-foreground">
              CVSS severity × EPSS exploit probability. The first row is the action item —
              investigate it first.
            </CardDescription>
          </div>
          <Badge variant="outline" className="font-mono text-caption">
            {top.length === 0 ? 'No risks' : `Top ${top.length}`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {top.length === 0 ? (
          <div className="flex items-center gap-2 px-6 py-8 text-caption text-muted-foreground">
            <CheckCircle2 className="size-4 text-brand-500" aria-hidden />
            <span>No findings flagged at this priority tier.</span>
          </div>
        ) : (
          <ol className="divide-y divide-border/70">
            {top.map((f, idx) => (
              <li
                key={f.id}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3 px-6 py-3 transition-colors hover:bg-brand-500/[0.04]"
              >
                <div className="flex items-start justify-center pt-1">
                  <span
                    className={cn(
                      'inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 font-mono text-caption font-semibold tabular-nums',
                      idx === 0
                        ? 'bg-destructive text-destructive-foreground shadow-sm'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {idx + 1}
                  </span>
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={`https://nvd.nist.gov/vuln/detail/${f.cveId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-body font-medium text-foreground underline-offset-2 hover:text-brand-600 hover:underline dark:hover:text-brand-300"
                    >
                      {f.cveId}
                    </a>
                    <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">
                      {f.matchReason}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {f.kevListed ? (
                      <Badge
                        variant="destructive"
                        className="font-mono uppercase tracking-wider"
                        title={
                          f.kevListedAt
                            ? `Active as of ${f.kevListedAt.slice(0, 10)}`
                            : 'CISA KEV: Active exploitation'
                        }
                      >
                        KEV: Active Exploitation
                      </Badge>
                    ) : null}
                    <Badge
                      variant={severityVariant(f.severity)}
                      className="font-mono uppercase tracking-wider"
                    >
                      {f.severity ?? 'unknown'}
                    </Badge>
                    <div
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 font-mono text-caption tabular-nums',
                        scoreTone(f.priorityScore ?? null),
                      )}
                      title={
                        f.components
                          ? `CVSS ${formatScore(f.components.cvssContribution)} · EPSS ${formatScore(f.components.epssContribution)} · ${
                              f.components.kevContribution > 0
                                ? `KEV ${formatScore(f.components.kevContribution)} · `
                                : ''
                            }(CVSS source: ${f.components.cvssSource ?? 'n/a'})`
                          : 'Priority = 0.6 × CVSS + 0.4 × EPSS + 2.0 × KEV'
                      }
                    >
                      <AlertTriangle className="size-3" aria-hidden />
                      <span className="font-semibold">Priority</span>
                      <span className="text-foreground">
                        {formatScore(f.priorityScore ?? null)}
                      </span>
                      <span className="text-muted-foreground">/10</span>
                    </div>
                    <div className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 font-mono text-caption tabular-nums text-muted-foreground">
                      <span>EPSS</span>
                      <span className="text-foreground">{formatPercent(f.epssScore ?? null)}</span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
