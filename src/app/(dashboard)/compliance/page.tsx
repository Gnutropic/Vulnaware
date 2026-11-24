// @polsia:user-owned — `/compliance` page. Client island: fetches one
// `ComplianceList` envelope from /api/compliance via apiFetch, then renders
// per-framework coverage cards and a filterable findings-by-control section.
// No Server Component metadata export (a 'use client' page already opts out);
// sibling layout may add metadata later if SEO is needed.

'use client';

import { Download, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FindingsByControl } from '@/components/custom/compliance/findings-by-control';
import { FrameworkCard } from '@/components/custom/compliance/framework-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiFetch } from '@/lib/api-client';
import {
  ComplianceList,
  type FrameworkCoverage as FrameworkCoverageData,
  type ComplianceFramework as FrameworkOption,
} from '@/lib/contracts/compliance';

type FrameworkId = FrameworkOption;
const FRAMEWORK_TABS: Array<{ id: FrameworkId; label: string }> = [
  { id: 'SOC2', label: 'SOC 2' },
  { id: 'HIPAA', label: 'HIPAA' },
  { id: 'NIST_800_53', label: 'NIST 800-53' },
];

export default function CompliancePage() {
  const [data, setData] = useState<ComplianceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [framework, setFramework] = useState<FrameworkId>('SOC2');
  const [severity, setSeverity] = useState<string>('all');
  const [controlQuery, setControlQuery] = useState<string>('');

  useEffect(() => {
    let active = true;
    apiFetch('/api/compliance', { schema: ComplianceList })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (!active) return;
        setError(msg);
        toast.error('Could not load compliance data.');
      });
    return () => {
      active = false;
    };
  }, []);

  const frameById = useMemo(() => {
    const map = new Map<FrameworkId, FrameworkCoverageData>();
    for (const f of data?.items ?? []) map.set(f.framework, f);
    return map;
  }, [data]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium text-muted-foreground">
              <ShieldCheck className="mr-1.5 inline size-4 align-[-0.18em] text-brand-500" />
              Compliance
            </p>
            {data ? (
              <Badge variant="outline" className="font-mono text-caption">
                Scans analyzed: {data.scansAnalyzed}
              </Badge>
            ) : null}
          </div>
          {data ? (
            <Button asChild variant="outline" size="sm">
              <a
                href={`/api/compliance/export?framework=${encodeURIComponent(framework)}`}
                download
              >
                <Download aria-hidden="true" className="mr-1.5 size-4" />
                Download PDF
              </a>
            </Button>
          ) : null}
        </div>
        <h1 className="font-display text-h1 tracking-tight text-foreground">Compliance coverage</h1>
        <p className="max-w-prose text-body-lg text-muted-foreground">
          Mapping of scan findings to SOC 2 (TSC), HIPAA Security Rule, and NIST SP 800-53 r5
          control families. Card pass/fail counts are card-relative: pass = static-universe controls
          with zero findings tagged; fail = unique controls with ≥1 finding.
        </p>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load compliance coverage</AlertTitle>
          <AlertDescription className="font-mono text-caption">{error}</AlertDescription>
        </Alert>
      ) : null}

      {!data && !error ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-[var(--radius-xl)] border border-border bg-card"
              aria-hidden
            />
          ))}
        </div>
      ) : null}

      {data ? (
        <section aria-label="Per-framework coverage" className="grid gap-4 lg:grid-cols-3">
          {FRAMEWORK_TABS.map((t) => {
            const f = frameById.get(t.id);
            if (!f) return null;
            return <FrameworkCard key={t.id} data={f} />;
          })}
        </section>
      ) : null}

      {data && data.findings.items.length === 0 ? (
        <Alert>
          <AlertTitle>No findings to map yet</AlertTitle>
          <AlertDescription>
            <Link href="/scans" className="font-medium underline-offset-2 hover:underline">
              Run a scan
            </Link>{' '}
            against a public hostname to populate this dashboard.
          </AlertDescription>
        </Alert>
      ) : null}

      {data && data.findings.items.length > 0 ? (
        <Tabs
          value={framework}
          onValueChange={(value) => setFramework(value as FrameworkId)}
          className="flex flex-col gap-6"
        >
          <TabsList className="self-start">
            {FRAMEWORK_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="compliance-severity"
                className="text-caption font-medium text-muted-foreground"
              >
                Severity
              </label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger id="compliance-severity" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All severities</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-1 flex-col gap-1">
              <label
                htmlFor="compliance-control"
                className="text-caption font-medium text-muted-foreground"
              >
                Search control ID
              </label>
              <input
                id="compliance-control"
                type="search"
                inputMode="search"
                placeholder="CC7.3, 164.312(e)(1), SC-8…"
                value={controlQuery}
                onChange={(event) => setControlQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>

          {FRAMEWORK_TABS.map((t) => (
            <TabsContent key={t.id} value={t.id}>
              <FindingsByControl
                findings={data.findings.items}
                framework={t.id}
                severityFilter={severity}
                controlQuery={controlQuery}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : null}
    </div>
  );
}
