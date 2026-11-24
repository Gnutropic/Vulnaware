// @polsia:user-owned — Single-scan result page. All data fetched from the
// client via @/lib/api-client; the page is a 'use client' island.

'use client';

import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { ScanFindingsTable } from '@/components/custom/scan-findings-table';
import { ScanResultCard } from '@/components/custom/scan-result-card';
import { TopRisksCard } from '@/components/custom/top-risks-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import { ScanItem } from '@/lib/contracts/scan';

function stateVariant(
  state: 'up' | 'down' | 'filtered',
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'up':
      return 'default';
    case 'filtered':
      return 'outline';
    case 'down':
      return 'destructive';
  }
}

type PageProps = { params: Promise<{ id: string }> };

export default function ScanDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const [scan, setScan] = useState<ScanItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch(`/api/scan/${id}`, { schema: ScanItem })
      .then((data) => {
        if (active) setScan(data);
      })
      .catch(() => {
        if (active) setError('Could not load this scan.');
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <main className="container-page section-lg space-y-10">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link href="/scans">
            <ArrowLeft className="size-4" aria-hidden /> Back to scans
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href={`/scans/${scan?.id ?? id}/report`}>
            <FileText className="size-4" aria-hidden /> View remediation report
          </Link>
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">Couldn’t load the scan</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : !scan ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
        </div>
      ) : (
        <>
          <ScanResultCard scan={scan} />

          <section aria-labelledby="top-risks-heading" className="space-y-3">
            <h2 id="top-risks-heading" className="sr-only">
              Top risks
            </h2>
            <TopRisksCard findings={scan.findings} />
          </section>

          <section aria-labelledby="assets-heading" className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 id="assets-heading" className="font-display text-h2 text-foreground">
                Probed assets
              </h2>
              <Badge variant="outline" className="font-mono text-caption">
                {scan.assets.length} ports
              </Badge>
            </div>
            <Card className="border-border/80 bg-card shadow-sm">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[8rem]">Port</TableHead>
                      <TableHead className="w-[7rem]">State</TableHead>
                      <TableHead className="w-[8rem]">Latency</TableHead>
                      <TableHead className="w-[10rem]">Service</TableHead>
                      <TableHead>Banner</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scan.assets.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono">{a.port}</TableCell>
                        <TableCell>
                          <Badge
                            variant={stateVariant(a.state)}
                            className="font-mono uppercase tracking-wider"
                          >
                            {a.state}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-caption text-muted-foreground">
                          {a.latencyMs != null ? `${a.latencyMs} ms` : '—'}
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
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="findings-heading" className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 id="findings-heading" className="font-display text-h2 text-foreground">
                Vulnerability findings
              </h2>
              <Badge variant="outline" className="font-mono text-caption">
                {scan.findings.length} findings
              </Badge>
            </div>
            <Card className="border-border/80 bg-card shadow-sm">
              <CardContent className="p-0">
                <ScanFindingsTable findings={scan.findings} />
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </main>
  );
}
