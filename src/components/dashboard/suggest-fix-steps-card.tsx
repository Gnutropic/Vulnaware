// @polsia:user-owned — Client island for cached AI-generated alert advice.
'use client';

import { Clipboard, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import {
  hasAlertRemediationContext,
  missingAlertRemediationContext,
} from '@/lib/business/alert-remediation-guidance';
import {
  AlertCveFixResponse,
  type AlertCveFixResponse as AlertCveFixResponseType,
  type AlertCveFix as AlertCveFixType,
} from '@/lib/contracts/alerts';

interface SuggestFixStepsAsset {
  id: string;
  host: string;
  ip: string;
  port: number;
  protocol: string;
  lastSeen: string | null;
}

interface SuggestFixStepsCardProps {
  alertId: string;
  cveId: string;
  description: string;
  asset: SuggestFixStepsAsset;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: AlertCveFixType | null }
  | { kind: 'done'; fix: AlertCveFixType }
  | { kind: 'insufficient_context'; missing: Array<'cve' | 'description'> }
  | { kind: 'unavailable' };

function isFix(wire: AlertCveFixResponseType): wire is AlertCveFixType {
  return 'steps' in wire;
}

function relativeAge(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 30) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function SuggestFixStepsCard({
  alertId,
  cveId,
  description,
  asset,
}: SuggestFixStepsCardProps) {
  const missingContext = missingAlertRemediationContext({ cveId, description });
  const hasContext = hasAlertRemediationContext({ cveId, description });
  const [status, setStatus] = useState<Status>(() =>
    hasContext ? { kind: 'idle' } : { kind: 'insufficient_context', missing: missingContext },
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasContext) return;
    let active = true;
    (async () => {
      try {
        const body = await apiFetch(`/api/alerts/${alertId}/suggested-fix`, {
          schema: AlertCveFixResponse,
        });
        if (!active) return;
        if (isFix(body)) {
          setStatus({ kind: 'done', fix: body });
        } else if (body.error === 'insufficient_context') {
          setStatus({ kind: 'insufficient_context', missing: body.missing });
        }
      } catch {
        // A cold cache stays idle so the operator can explicitly generate advice.
      }
    })();
    return () => {
      active = false;
    };
  }, [alertId, hasContext]);

  async function handleGenerate() {
    if (status.kind === 'loading') return;
    const previous = status.kind === 'done' ? status.fix : null;
    setStatus({ kind: 'loading', previous });
    try {
      const body = await apiFetch(`/api/alerts/${alertId}/suggested-fix`, {
        method: 'POST',
        schema: AlertCveFixResponse,
      });
      if (!mountedRef.current) return;
      if (isFix(body)) {
        setStatus({ kind: 'done', fix: body });
      } else if (body.error === 'insufficient_context') {
        setStatus({ kind: 'insufficient_context', missing: body.missing });
      } else {
        toast.error('AI-generated advice is unavailable. Try again in a moment.');
        setStatus(previous ? { kind: 'done', fix: previous } : { kind: 'unavailable' });
      }
    } catch {
      toast.error('AI-generated advice is unavailable. Try again in a moment.');
      if (mountedRef.current) {
        setStatus(previous ? { kind: 'done', fix: previous } : { kind: 'unavailable' });
      }
    }
  }

  async function handleCopy() {
    if (status.kind !== 'done') return;

    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(status.fix.steps.map((step) => step.body).join('\n'));
      toast.success('Guidance copied.');
    } catch {
      toast.error('Could not copy remediation guidance.');
    }
  }

  const isLoading = status.kind === 'loading';
  const doneFix = status.kind === 'done' ? status.fix : null;

  if (status.kind === 'insufficient_context') {
    const missing = status.missing;
    return (
      <Card
        className="border-border/80 bg-card shadow-sm"
        data-testid="suggest-fix-steps-insufficient-context"
      >
        <CardHeader className="space-y-2">
          <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
            AI-generated advice
          </CardDescription>
          <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
            <Sparkles className="size-4 text-brand-500" aria-hidden />
            Insufficient context
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-prose text-body text-muted-foreground">
            AI-generated advice needs {missing.includes('cve') ? 'a real CVE identifier' : null}
            {missing.includes('cve') && missing.includes('description') ? ' and ' : null}
            {missing.includes('description') ? 'the vulnerability description' : null} for this
            alert. Advice only — no fix has been applied.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              AI-generated advice
            </CardDescription>
            <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
              <Sparkles className="size-4 text-brand-500" aria-hidden />
              Suggest fix steps with AI
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {doneFix ? (
              <Badge
                variant="secondary"
                className="font-mono text-caption uppercase tracking-wider"
              >
                Generated {relativeAge(doneFix.generatedAt, Date.now())}
              </Badge>
            ) : null}
            {doneFix ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCopy()}
                aria-label="Copy remediation guidance"
                data-testid="suggest-fix-steps-copy-button"
              >
                <Clipboard className="size-4" aria-hidden />
                Copy guidance
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={() => void handleGenerate()}
              disabled={isLoading}
              aria-disabled={isLoading}
              data-testid="suggest-fix-steps-button"
            >
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles className="size-4" aria-hidden />
                  Suggest fix steps with AI
                </>
              )}
            </Button>
          </div>
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          <span className="font-mono">{cveId}</span>
          {asset.host ? (
            <>
              {' '}
              on{' '}
              <span className="font-mono">
                {asset.host}
                {asset.ip ? `:${asset.port}/${asset.protocol}` : ''}
              </span>
            </>
          ) : null}
          <span className="mt-2 block">Advice only — no fix has been applied.</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status.kind === 'idle' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            Click Suggest fix steps with AI to generate 2–3 concise, informational steps grounded in
            this alert. Results are cached per alert.
          </p>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Generating AI-generated advice…
          </div>
        ) : doneFix ? (
          <ol
            className="flex flex-col gap-3"
            data-testid="suggest-fix-steps-list"
            aria-label="AI-generated advice steps"
          >
            {doneFix.steps.map((step, index) => (
              <li
                key={step.id}
                className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground">
                    Step {index + 1}
                  </span>
                  <span className="font-medium text-body text-foreground">{step.title}</span>
                </span>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/60 p-2 font-mono text-caption text-foreground">
                  {step.body}
                </pre>
              </li>
            ))}
          </ol>
        ) : (
          <div
            className="flex flex-col gap-1 text-body text-muted-foreground"
            data-testid="suggest-fix-steps-fallback"
          >
            <span>AI-generated advice is temporarily unavailable.</span>
            <span className="text-caption">
              Click Suggest fix steps with AI to retry once the proxy is reachable. Advice only — no
              fix has been applied.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
