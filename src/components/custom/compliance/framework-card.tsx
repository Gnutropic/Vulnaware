// @polsia:user-owned — Framework coverage card. Pure presentational; props
// typed from the shared compliance contract.

'use client';

import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { FrameworkCoverage as FrameworkCoverageData } from '@/lib/contracts/compliance';

const FRAMEWORK_NAME: Record<FrameworkCoverageData['framework'], string> = {
  SOC2: 'SOC 2 (TSC 2017)',
  HIPAA: 'HIPAA Security Rule',
  NIST_800_53: 'NIST SP 800-53 r5',
};

const FRAMEWORK_BADGE: Record<FrameworkCoverageData['framework'], string> = {
  SOC2: 'Trust Services Criteria',
  HIPAA: '45 CFR § 164',
  NIST_800_53: 'Federal controls',
};

interface FrameworkCardProps {
  data: FrameworkCoverageData;
}

export function FrameworkCard({ data }: FrameworkCardProps) {
  const total = data.passCount + data.failCount;
  const pct = total === 0 ? 0 : Math.round((data.passCount / total) * 100);

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardDescription className="text-eyebrow uppercase tracking-normal">
              {FRAMEWORK_BADGE[data.framework]}
            </CardDescription>
            <CardTitle className="font-display text-h3 text-foreground">
              {FRAMEWORK_NAME[data.framework]}
            </CardTitle>
          </div>
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-brand-500" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-caption text-muted-foreground">Pass</p>
            <p className="font-display text-h3 text-emerald-600 dark:text-emerald-400">
              {data.passCount}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-caption text-muted-foreground">Fail</p>
            <p className="font-display text-h3 text-destructive">{data.failCount}</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-caption text-muted-foreground">Findings</p>
            <p className="font-display text-h3 text-foreground">{data.totalFindings}</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-caption text-muted-foreground">
            <span>Coverage</span>
            <span className="font-mono">{pct}%</span>
          </div>
          <Progress value={pct} aria-label={`${data.framework} coverage`} />
        </div>

        <div className="flex flex-wrap gap-2 border-t border-border/70 pt-3">
          {data.controls
            .filter((c) => c.failing > 0)
            .slice(0, 4)
            .map((c) => (
              <Badge key={c.controlId} variant="destructive" className="font-mono text-caption">
                {c.controlId} · {c.failing}
              </Badge>
            ))}
          {data.failCount === 0 && (
            <Badge variant="secondary" className="font-mono text-caption">
              No failing controls
            </Badge>
          )}
          {data.failCount > 4 && (
            <Badge variant="outline" className="font-mono text-caption">
              +{data.failCount - 4} more
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
