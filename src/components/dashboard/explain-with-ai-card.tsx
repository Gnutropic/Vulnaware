// @polsia:user-owned — Alert detail island for AI priority and remediation explanations.

'use client';

import { Copy, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import {
  AlertGuidanceContent,
  AlertGuidanceResponse,
  type AlertGuidanceResponse as AlertGuidanceResponseType,
  AlertGuidanceUnavailable,
  type AlertGuidanceUnavailable as AlertGuidanceUnavailableType,
} from '@/lib/contracts/alert-ai-guidance';

interface ExplainWithAiAsset {
  host: string;
  ip: string;
  port: number;
  protocol: string;
}

interface ExplainWithAiCardProps {
  alertId: string;
  cveId: string;
  severity: string | null;
  cvssScore: number | null;
  asset: ExplainWithAiAsset;
  initialText?: string | null;
  initialGeneratedAt?: string | null;
}

type Status = 'idle' | 'loading' | 'done' | 'insufficient_context' | 'unavailable';

function parseCachedContent(value: string | null | undefined) {
  if (!value) return null;
  try {
    const content: unknown = JSON.parse(value);
    const parsed = AlertGuidanceContent.safeParse(content);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readFailure(error: unknown): AlertGuidanceUnavailableType | null {
  if (!(error instanceof Error)) return null;
  const parsed = AlertGuidanceUnavailable.safeParse(error.cause);
  return parsed.success ? parsed.data : null;
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function missingLabels(failure: AlertGuidanceUnavailableType): string | null {
  if (!failure.missing?.length) return null;
  const labels: Record<NonNullable<AlertGuidanceUnavailableType['missing']>[number], string> = {
    cve: 'CVE identifier',
    description: 'vulnerability description',
    severity: 'stored severity',
    priority: 'CVSS or priority score',
    asset: 'affected asset details',
  };
  return failure.missing.map((field) => labels[field]).join(', ');
}

export function ExplainWithAiCard({
  alertId,
  cveId,
  severity,
  cvssScore,
  asset,
  initialText,
  initialGeneratedAt,
}: ExplainWithAiCardProps) {
  const [result, setResult] = useState(() => parseCachedContent(initialText));
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialGeneratedAt ?? null);
  const [status, setStatus] = useState<Status>(() => (result ? 'done' : 'idle'));
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    const cached = parseCachedContent(initialText);
    setResult(cached);
    setGeneratedAt(cached ? (initialGeneratedAt ?? null) : null);
    setMissing(null);
    setStatus(cached ? 'done' : 'idle');
  }, [initialText, initialGeneratedAt]);

  async function generate() {
    if (status === 'loading') return;
    setStatus('loading');
    setResult(null);
    setGeneratedAt(null);
    setMissing(null);
    try {
      const explanation: AlertGuidanceResponseType = await apiFetch(
        `/api/alerts/${encodeURIComponent(alertId)}/explain`,
        { method: 'POST', schema: AlertGuidanceResponse },
      );
      setResult({
        priorityRationale: explanation.priorityRationale,
        remediationExplanation: explanation.remediationExplanation,
      });
      setGeneratedAt(explanation.generatedAt);
      setStatus('done');
    } catch (error) {
      const failure = readFailure(error);
      if (failure?.error === 'insufficient_context') {
        setMissing(missingLabels(failure));
        setStatus('insufficient_context');
      } else {
        setStatus('unavailable');
      }
    }
  }

  async function copyGuidance() {
    if (!result) return;
    const text = [
      `Priority rationale\n${result.priorityRationale}`,
      `Remediation explanation\n${result.remediationExplanation}`,
    ].join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Guidance copied.');
    } catch {
      toast.error('Copy failed.');
    }
  }

  const generatedLabel = formatTimestamp(generatedAt);

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              AI guidance
            </CardDescription>
            <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
              <Sparkles className="size-4 text-brand-500" aria-hidden />
              Priority and remediation
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status === 'done' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyGuidance()}
                disabled={!result}
              >
                <Copy className="size-4" aria-hidden /> Copy
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={() => void generate()}
              disabled={status === 'loading'}
            >
              {status === 'loading' ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="size-4" aria-hidden />
                  {status === 'done' ? 'Regenerate explanations' : 'Generate explanations'}
                </>
              )}
            </Button>
          </div>
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          <span className="font-mono">{cveId || 'Unknown CVE'}</span>
          {asset.host ? (
            <>
              {' '}
              on <span className="font-mono">{asset.host}</span>
              {asset.port > 0 ? `:${asset.port}/${asset.protocol}` : ''}
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-caption text-muted-foreground">
          Recorded severity:{' '}
          <span className="font-medium text-foreground">{severity || 'Not recorded'}</span>
          {cvssScore == null ? '' : ` · CVSS ${cvssScore.toFixed(1)}`}. AI guidance is advisory and
          does not change the stored severity.
        </p>

        {status === 'idle' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            Generate a rationale for the alert’s recorded priority and a remediation explanation
            from its available details.
          </p>
        ) : null}
        {status === 'loading' ? (
          <p className="flex items-center gap-2 text-body text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Generating explanations from
            this alert…
          </p>
        ) : null}
        {status === 'insufficient_context' ? (
          <output className="max-w-prose text-body text-muted-foreground">
            A reliable explanation cannot be generated from the available information
            {missing ? `; missing ${missing}` : ''}. No explanation is shown.
          </output>
        ) : null}
        {status === 'unavailable' ? (
          <p className="max-w-prose text-body text-destructive" role="alert">
            The explanations could not be generated. Please try again later.
          </p>
        ) : null}
        {status === 'done' && result ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-border/70 bg-muted/20 p-4">
              <h3 className="text-sm font-semibold text-foreground">Priority rationale</h3>
              <p className="mt-2 max-w-prose whitespace-pre-wrap text-body leading-relaxed text-foreground">
                {result.priorityRationale}
              </p>
            </section>
            <section className="rounded-lg border border-border/70 bg-muted/20 p-4">
              <h3 className="text-sm font-semibold text-foreground">Remediation explanation</h3>
              <p className="mt-2 max-w-prose whitespace-pre-wrap text-body leading-relaxed text-foreground">
                {result.remediationExplanation}
              </p>
            </section>
            {generatedLabel ? (
              <p className="text-caption text-muted-foreground md:col-span-2">
                Generated {generatedLabel}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
