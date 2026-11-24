// @polsia:user-owned — Client island that renders the cached AI suggested
// fix for one alert. Sister island to cve-summary-card.tsx; data flows
// entirely through apiFetch('/api/alerts/[id]/suggested-fix') — no Prisma,
// no server-only imports. The parent supplies cveId + asset so this
// island can render contextual labels (CVE, host) even before its first
// GET resolves.
//
// State machine:
//   - idle  → initial mount; GET in flight.
//   - cached  → show ordered list of steps from the parsed envelope.
//   - unavailable  → GET returned `{ error: 'unavailable' }` or POST failed.
//   - regenerating  → POST in flight; render a spinner, disable the button.
// Regenerate button stays enabled in `unavailable` and `cached` so a
// failed regen can be retried; on failure the optimistic update is
// reverted and a toast surfaces the error.

'use client';

import { Check, Copy, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import {
  AlertCveFix,
  type AlertCveFix as AlertCveFixType,
  AlertCveFixUnavailable,
} from '@/lib/contracts/alerts';

interface SuggestedFixAsset {
  id: string;
  host: string;
  ip: string;
  port: number;
  protocol: string;
  lastSeen: string | null;
}

interface SuggestedFixCardProps {
  alertId: string;
  cveId: string;
  asset: SuggestedFixAsset;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'cached'; fix: AlertCveFixType }
  | { kind: 'unavailable' }
  | { kind: 'regenerating'; previous: AlertCveFixType | null };

type WireResponse = AlertCveFixType | { error: 'not_found' | 'unavailable' };

function parseWire(body: unknown): WireResponse {
  // The route returns AlertCveFix on hit and AlertCveFixUnavailable on
  // miss/failure. We zod-parse each branch so future drift surfaces a
  // parse error instead of a silent misrender.
  if (body && typeof body === 'object' && 'steps' in body && 'generatedAt' in body) {
    return AlertCveFix.parse(body);
  }
  return AlertCveFixUnavailable.parse(body);
}

function isUnavailable(wire: WireResponse): wire is { error: 'not_found' | 'unavailable' } {
  return 'error' in wire;
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
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function SuggestedFixCard({ alertId, cveId, asset }: SuggestedFixCardProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Defends setStatus() / setCopiedId() against "unmount during refetch"
  // warnings. The initial GET path already has its `active` flag inside
  // its useEffect, but the Regenerate handler fires a SECOND refetch and
  // the Copy handler schedules a deferred setCopiedId() inside a 1500 ms
  // setTimeout — without this a user closing the tab mid-action would leak
  // a React state update on an unmounted island.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const body = await apiFetch(`/api/alerts/${alertId}/suggested-fix`);
        const wire = parseWire(body);
        if (!active) return;
        setStatus(isUnavailable(wire) ? { kind: 'unavailable' } : { kind: 'cached', fix: wire });
      } catch {
        if (!active) return;
        // 404 (alert gone — race with delete) renders as "unavailable"
        // here; the parent island surfaces its own error card for the
        // detail payload.
        setStatus({ kind: 'unavailable' });
      }
    })();
    return () => {
      active = false;
    };
  }, [alertId]);

  async function handleRegenerate() {
    if (status.kind === 'regenerating') return;
    const previous = status.kind === 'cached' ? status.fix : null;
    setStatus({ kind: 'regenerating', previous });
    try {
      const body = await apiFetch(`/api/alerts/${alertId}/suggested-fix`, { method: 'POST' });
      if (!mountedRef.current) return;
      const wire = parseWire(body);
      if (isUnavailable(wire)) {
        toast.error('AI suggested fix unavailable. Try again in a moment.');
        if (!mountedRef.current) return;
        setStatus(previous ? { kind: 'cached', fix: previous } : { kind: 'unavailable' });
      } else {
        setStatus({ kind: 'cached', fix: wire });
      }
    } catch {
      toast.error('AI suggested fix unavailable. Try again in a moment.');
      try {
        const body = await apiFetch(`/api/alerts/${alertId}/suggested-fix`);
        if (!mountedRef.current) return;
        const wire = parseWire(body);
        setStatus(isUnavailable(wire) ? { kind: 'unavailable' } : { kind: 'cached', fix: wire });
      } catch {
        if (!mountedRef.current) return;
        setStatus(previous ? { kind: 'cached', fix: previous } : { kind: 'unavailable' });
      }
    }
  }

  async function handleCopy(step: { id: string; body: string }) {
    const mountedAtCall = mountedRef.current;
    const ok = await copyToClipboard(step.body);
    if (!mountedAtCall) return;
    if (ok) {
      setCopiedId(step.id);
      toast.success('Copied');
      setTimeout(() => {
        if (!mountedRef.current) return;
        setCopiedId((current) => (current === step.id ? null : current));
      }, 1500);
    } else {
      toast.error('Copy not supported in this browser.');
    }
  }

  const isRegenerating = status.kind === 'regenerating';
  const cachedFix = status.kind === 'cached' ? status.fix : null;
  const regeneratingFromCached = status.kind === 'regenerating' ? status.previous : null;

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              AI remediation
            </CardDescription>
            <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
              <Sparkles className="size-4 text-brand-500" aria-hidden />
              Suggested fix
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {cachedFix ? (
              <Badge
                variant="secondary"
                className="font-mono text-caption uppercase tracking-wider"
              >
                Generated {relativeAge(cachedFix.generatedAt, Date.now())}
              </Badge>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleRegenerate}
              disabled={isRegenerating}
              aria-disabled={isRegenerating}
            >
              {isRegenerating ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Regenerating…
                </>
              ) : (
                'Regenerate'
              )}
            </Button>
          </div>
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          <span className="font-mono">{cveId || 'UNKNOWN'}</span>
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
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status.kind === 'idle' || isRegenerating ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {isRegenerating && regeneratingFromCached ? 'Regenerating fix…' : 'Generating fix…'}
          </div>
        ) : cachedFix ? (
          cachedFix.steps.length > 0 ? (
            <ol className="flex flex-col gap-3">
              {cachedFix.steps.map((step, idx) => (
                <li
                  key={step.id}
                  className="rounded-lg border border-border/60 bg-muted/30 p-3 transition-colors hover:border-border"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-1 flex-col gap-1">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground">
                          Step {idx + 1}
                        </span>
                        <span className="font-medium text-body text-foreground">{step.title}</span>
                      </span>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/60 p-2 font-mono text-caption text-foreground">
                        {step.body}
                      </pre>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleCopy(step)}
                      aria-label={`Copy step ${idx + 1} to clipboard`}
                    >
                      {copiedId === step.id ? (
                        <Check className="size-4 text-brand-500" aria-hidden />
                      ) : (
                        <Copy className="size-4" aria-hidden />
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="max-w-prose text-body text-muted-foreground">
              AI suggested fix is empty for this alert. Try regenerating.
            </p>
          )
        ) : (
          <div className="flex flex-col gap-1 text-body text-muted-foreground">
            <span>AI suggested fix temporarily unavailable.</span>
            <span className="text-caption">
              Click Regenerate to retry once the proxy is reachable.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
