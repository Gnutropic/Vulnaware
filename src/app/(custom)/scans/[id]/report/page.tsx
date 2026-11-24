// @polsia:user-owned — Printable remediation report page island. Consumes
// GET /api/scan/<id>/report via @/lib/api-client (ReportItem schema), then
// renders ReportView. Page is 'use client' — no DB/Prisma in this file; the
// route handler owns the read. 'use client' also precludes an exported
// `metadata` (consistency with /scans/[id]); the framework layout's title
// template still resolves at navigation.

'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { ReportView } from '@/components/custom/report-view';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { ReportItem } from '@/lib/contracts/scan';

type PageProps = { params: Promise<{ id: string }> };

export default function ScanReportPage({ params }: PageProps) {
  const { id } = use(params);
  const [report, setReport] = useState<ReportItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch(`/api/scan/${id}/report`, { schema: ReportItem })
      .then((data) => {
        if (active) setReport(data);
      })
      .catch(() => {
        if (active) setError('Could not load this report.');
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <main className="container-page section-lg space-y-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link href={`/scans/${id}`}>
          <ArrowLeft className="size-4" aria-hidden /> Back to scan
        </Link>
      </Button>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">Couldn’t load the report</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : !report ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading remediation report…
        </div>
      ) : (
        <ReportView report={report} />
      )}
    </main>
  );
}
