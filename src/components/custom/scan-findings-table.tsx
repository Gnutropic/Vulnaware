// @polsia:user-owned — Vulnerability findings table for a single asset or a
// whole scan. Composes Table + Badge; no data fetching.

'use client';

import { AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { VulnerabilityFindingItem } from '@/lib/contracts/scan';

function severityVariant(sev: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical') return 'destructive';
  if (s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  if (s === 'low') return 'outline';
  return 'outline';
}

export function ScanFindingsTable({ findings }: { findings: VulnerabilityFindingItem[] }) {
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-border bg-muted/40 px-4 py-8 text-caption text-muted-foreground">
        <AlertCircle className="size-4" aria-hidden />
        <span>No matching CVEs for the probed services.</span>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[12rem]">CVE</TableHead>
          <TableHead className="w-[7rem]">Severity</TableHead>
          <TableHead>Why it matched</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((f) => (
          <TableRow key={f.id}>
            <TableCell className="font-mono text-caption">
              <a
                href={`https://nvd.nist.gov/vuln/detail/${f.cveId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {f.cveId}
              </a>
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={severityVariant(f.severity)}
                  className="font-mono uppercase tracking-wider"
                >
                  {f.severity ?? 'unknown'}
                </Badge>
                {f.kevListed ? (
                  <Badge
                    variant="destructive"
                    className="font-mono uppercase tracking-wider"
                    title={
                      f.kevListedAt
                        ? `Active as of ${f.kevListedAt.slice(0, 10)}`
                        : 'Active exploitation (CISA KEV)'
                    }
                  >
                    KEV: Active Exploitation
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="text-body text-muted-foreground">{f.matchReason}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
