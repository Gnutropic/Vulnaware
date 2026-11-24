// @polsia:user-owned — Printable remediation report view. Pure presentational
// client component; consumes the fully-parsed ReportItem envelope the
// /api/scan/<id>/report handler returns. Renders a header card (target / mode
// / started / finished) and one card per CVE group: severity badge,
// CVSS/EPSS/Priority triple, matched-asset table, recommended fix + version
// line + verification step + reference list. Print-friendly via the
// print: tweaks in src/app/custom-style.css so a security lead can hit the
// browser print dialog and get a clean, no-frills PDF/HTML the engineering
// team can act on.

'use client';

import { AlertCircle, CheckCircle2, FileText, Printer, ShieldAlert, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { isHighRiskPriorityScore } from '@/lib/business/scanner/prioritize';
import type { ReportItem } from '@/lib/contracts/scan';
import { cn } from '@/lib/utils';

function severityVariant(sev: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
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

function formatScore(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return 'n/a';
  return s.toFixed(2);
}

function formatPercent(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return 'n/a';
  return `${(p * 100).toFixed(1)}%`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}

function StatusPill({ status }: { status: 'queued' | 'running' | 'completed' | 'failed' }) {
  const variant =
    status === 'completed'
      ? 'default'
      : status === 'failed'
        ? 'destructive'
        : status === 'running'
          ? 'secondary'
          : 'outline';
  return (
    <Badge variant={variant} className="font-mono uppercase tracking-wider">
      {status}
    </Badge>
  );
}

function MetricChip({
  label,
  value,
  suffix,
  tone,
  title,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 font-mono text-caption tabular-nums',
        tone,
      )}
    >
      <span className="font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
      {suffix ? <span className="text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

export function ReportView({ report }: { report: ReportItem }) {
  const { scan, cveGroups } = report;
  const completedAt =
    scan.finishedAt != null
      ? `Finished ${formatTimestamp(scan.finishedAt)}`
      : `Started ${formatTimestamp(scan.startedAt)} — still running`;

  return (
    <main className="container-page section-lg space-y-10">
      {/* HEADER — printable header card. */}
      <Card className="overflow-hidden border-brand-500/40 bg-gradient-to-br from-brand-500/[0.08] via-card to-card shadow-brand print:shadow-none print:border-foreground/40">
        <CardHeader className="border-b border-border/60 bg-card/60 backdrop-blur-sm print:bg-transparent print:border-foreground/20">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <p className="flex items-center gap-1.5 text-eyebrow text-brand-600 dark:text-brand-300">
                <FileText className="size-3.5" aria-hidden /> Remediation report
              </p>
              <CardTitle className="font-display text-h2 text-foreground">
                <span className="block text-caption font-medium text-muted-foreground">Target</span>
                <span className="block break-all font-mono text-h2 tracking-tight text-foreground">
                  {scan.target}
                </span>
              </CardTitle>
              <CardDescription className="text-caption text-muted-foreground">
                Scan <span className="font-mono">{scan.id}</span> · mode {scan.mode} · {completedAt}
              </CardDescription>
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusPill status={scan.status} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="no-print"
                onClick={() => {
                  if (typeof window !== 'undefined') window.print();
                }}
              >
                <Printer className="size-4" aria-hidden /> Print / save as PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 p-6 md:grid-cols-3">
          <div className="space-y-1">
            <p className="text-caption uppercase tracking-wider text-muted-foreground">Started</p>
            <p className="font-mono text-small text-foreground">
              {formatTimestamp(scan.startedAt)}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-caption uppercase tracking-wider text-muted-foreground">Finished</p>
            <p className="font-mono text-small text-foreground">
              {scan.finishedAt ? formatTimestamp(scan.finishedAt) : '—'}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-caption uppercase tracking-wider text-muted-foreground">Mode</p>
            <p className="font-mono text-small text-foreground">{scan.mode}</p>
          </div>
        </CardContent>
      </Card>

      {/* BODY */}
      {cveGroups.length === 0 ? (
        <Card className="border-brand-500/40 bg-gradient-to-br from-brand-500/[0.05] via-card to-card">
          <CardContent className="flex flex-col items-start gap-4 p-8">
            <div className="flex items-center gap-2 text-brand-600 dark:text-brand-300">
              <CheckCircle2 className="size-5" aria-hidden />
              <p className="text-eyebrow">Clean scan</p>
            </div>
            <h2 className="font-display text-h3 text-foreground">
              No CVE matches against the probed surface.
            </h2>
            <p className="max-w-prose text-body text-muted-foreground">
              The probed banners did not match any CVE in the local seed table or the live feeds
              reachable at scan time. Continue to monitor this asset — a re-scan against future CVE
              feeds may surface new findings as advisories are published.
            </p>
          </CardContent>
        </Card>
      ) : (
        <section aria-labelledby="report-groups-heading" className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 id="report-groups-heading" className="font-display text-h2 text-foreground">
              Vulnerabilities to address
            </h2>
            <Badge variant="outline" className="font-mono text-caption">
              {cveGroups.length} {cveGroups.length === 1 ? 'CVE' : 'CVEs'}
            </Badge>
          </div>

          {/* eslint-disable-next-line react/no-array-index-key — stable order from server sort */}
          {cveGroups.map((group, idx) => {
            const sev = group.severity;
            return (
              <Card
                key={group.cveId}
                className="overflow-hidden border-border/80 bg-card shadow-sm print:break-inside-avoid print:shadow-none"
              >
                <CardHeader className="border-b border-border/60 bg-muted/30 print:bg-transparent">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-caption font-semibold tabular-nums text-brand-600 dark:text-brand-300">
                          #{String(idx + 1).padStart(2, '0')}
                        </span>
                        <Badge
                          variant={severityVariant(sev)}
                          className="font-mono uppercase tracking-wider"
                        >
                          {sev ?? 'unknown'}
                        </Badge>
                        {group.kevListed ? (
                          <Badge
                            variant="destructive"
                            className="font-mono uppercase tracking-wider"
                            title={
                              group.dateAdded
                                ? `Active as of ${group.dateAdded}`
                                : 'CISA KEV: Active exploitation'
                            }
                          >
                            KEV: Active Exploitation
                          </Badge>
                        ) : null}
                        <Badge variant="outline" className="font-mono">
                          {group.matchedAssets.length}{' '}
                          {group.matchedAssets.length === 1 ? 'asset' : 'assets'}
                        </Badge>
                      </div>
                      <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                        <a
                          href={`https://nvd.nist.gov/vuln/detail/${group.cveId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono underline-offset-2 hover:text-brand-600 hover:underline dark:hover:text-brand-300"
                        >
                          {group.cveId}
                        </a>
                      </CardTitle>
                      <CardDescription className="text-body text-muted-foreground">
                        {group.summary}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <MetricChip
                        label="CVSS"
                        value={formatScore(group.cvssScore)}
                        suffix="/10"
                        tone={scoreTone(group.cvssScore)}
                      />
                      <MetricChip
                        label="EPSS"
                        value={formatPercent(group.epssScore)}
                        tone={scoreTone(group.priorityScore)}
                      />
                      <MetricChip
                        label="Priority"
                        value={formatScore(group.priorityScore)}
                        suffix="/10"
                        tone={scoreTone(group.priorityScore)}
                      />
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-6 p-6">
                  <section aria-labelledby={`${group.cveId}-assets-heading`} className="space-y-3">
                    <h3
                      id={`${group.cveId}-assets-heading`}
                      className="font-display text-h4 tracking-tight text-foreground"
                    >
                      Matched assets
                    </h3>
                    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border/80 bg-card shadow-xs">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[8rem]">Port</TableHead>
                            <TableHead>Host</TableHead>
                            <TableHead className="w-[10rem]">IP</TableHead>
                            <TableHead className="w-[10rem]">Service</TableHead>
                            <TableHead>Banner</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.matchedAssets.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell className="font-mono text-caption">{a.port}</TableCell>
                              <TableCell className="font-mono text-caption text-foreground">
                                {a.host}
                              </TableCell>
                              <TableCell className="font-mono text-caption text-muted-foreground">
                                {a.ip}
                              </TableCell>
                              <TableCell className="font-mono text-caption">
                                {a.serviceHint ?? '—'}
                              </TableCell>
                              <TableCell
                                className="max-w-[28rem] truncate text-caption text-muted-foreground"
                                title={a.banner ?? ''}
                              >
                                {a.banner ?? '—'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </section>

                  <Separator />

                  <section
                    aria-labelledby={`${group.cveId}-remediation-heading`}
                    className="space-y-3"
                  >
                    <div className="flex items-center gap-2">
                      <Wrench className="size-4 text-brand-500" aria-hidden />
                      <h3
                        id={`${group.cveId}-remediation-heading`}
                        className="font-display text-h4 tracking-tight text-foreground"
                      >
                        Remediation
                      </h3>
                    </div>

                    <div className="rounded-[var(--radius-lg)] border border-border/80 bg-background p-5 shadow-xs print:border-foreground/30">
                      <dl className="grid gap-4 md:grid-cols-[8rem_minmax(0,1fr)]">
                        <dt className="text-caption font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
                          Fix
                        </dt>
                        <dd className="text-body text-foreground">{group.recommendedFix}</dd>

                        <dt className="text-caption font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
                          Version
                        </dt>
                        <dd className="font-mono text-body text-foreground">
                          {group.fixVersionOrPatch ?? (
                            <span className="text-muted-foreground">not applicable</span>
                          )}
                        </dd>

                        <dt className="text-caption font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
                          Verify
                        </dt>
                        <dd className="font-mono text-small leading-relaxed text-foreground">
                          {group.verificationStep}
                        </dd>
                      </dl>
                    </div>
                  </section>

                  <section aria-labelledby={`${group.cveId}-refs-heading`} className="space-y-3">
                    <h3
                      id={`${group.cveId}-refs-heading`}
                      className="font-display text-h4 tracking-tight text-foreground"
                    >
                      References
                    </h3>
                    <ul className="space-y-1.5 text-body">
                      {group.references.map((href) => (
                        <li
                          key={href}
                          className="break-all font-mono text-caption text-muted-foreground"
                        >
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-600 underline-offset-4 hover:underline dark:text-brand-300"
                          >
                            {href}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                </CardContent>
              </Card>
            );
          })}
        </section>
      )}

      {cveGroups.length > 0 ? (
        <p className="flex items-start gap-2 text-caption text-muted-foreground print:mt-6">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-brand-500" aria-hidden />
          <span>
            Verify each fix on the asset, then re-run the scan from the{' '}
            <span className="font-mono">/scans</span> page — the matching findings should drop off
            automatically.
          </span>
        </p>
      ) : null}

      {/* Empty findings guard mirrors the per-asset findings empty state. */}
      {cveGroups.length > 0 && cveGroups.every((g) => g.matchedAssets.length === 0) ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-border bg-muted/40 px-4 py-6 text-caption text-muted-foreground">
          <AlertCircle className="size-4" aria-hidden />
          <span>No matched asset rows for these findings — investigate the seed/matcher logs.</span>
        </div>
      ) : null}
    </main>
  );
}
