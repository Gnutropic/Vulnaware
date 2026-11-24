// @polsia:user-owned — Per-alert streamed "Stakeholder summary" client
// island. Sister island to explain-with-ai-card.tsx +
// suggested-remediation-card.tsx; calls POST /api/alerts/[id]/summary/stream
// (raw fetch, NOT apiFetch, because the route returns an OpenAI-
// compatible SSE stream, not JSON), pumps the bytes through the same
// TextDecoder + `data:` splitting pattern, and renders the running text
// as a single prose paragraph inside a `<p>` once the stream closes.
//
// Why a separate surface (cached `/api/.../summary` JSON + streamed
// `/api/.../summary/stream` SSE): the cached JSON card is the long-lived
// first-look paragraph that survives across reloads. The streamed
// paragraph is the "give me a fresh exec-ready brief RIGHT NOW" gesture
// — no cache, no stale version, ready to paste into a leadership
// briefing doc. Streaming does NOT write through to AlertCveSummary;
// the brief is intentionally ephemeral.
//
// State machine (mirrors explain-with-ai-card.tsx verbatim):
//   - idle   → initial state. Click "Generate stakeholder summary"
//     starts the stream.
//   - loading → POST in flight, headers not yet received.
//   - streaming → response ok; SSE pump appending deltas.
//   - done     → upstream closed cleanly; paragraph is final.
//   - unavailable → POST/streaming failed; user can retry.

'use client';

import { Copy, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface StakeholderSummaryAsset {
  host: string;
  ip: string;
  port: number;
  protocol: string;
}

interface StakeholderSummaryCardProps {
  alertId: string;
  cveId: string;
  asset: StakeholderSummaryAsset;
}

type Status = 'idle' | 'loading' | 'streaming' | 'done' | 'unavailable';

const CLIENT_TIMEOUT_MS = 35_000;

function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      );
    }
    return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

export function StakeholderSummaryCard({ alertId, cveId, asset }: StakeholderSummaryCardProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [text, setText] = useState('');
  // In-flight cancellation handle. Stays across re-renders so onUnmount
  // can tear the stream down even after a state-machine transition.
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors the mounted state so a stream decode that completes after a
  // unmount doesn't try to setState on a dead island.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort(new Error('unmount'));
    };
  }, []);

  async function stream() {
    if (status === 'loading' || status === 'streaming') return;
    setStatus('loading');
    setText('');

    const ac = new AbortController();
    abortRef.current = ac;
    const timer = setTimeout(() => ac.abort(new Error('client_timeout')), CLIENT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`/api/alerts/${alertId}/summary/stream`, {
        method: 'POST',
        signal: ac.signal,
        cache: 'no-store',
      });
    } catch (err) {
      clearTimeout(timer);
      if (!mountedRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') {
        setStatus(text ? 'done' : 'idle');
        return;
      }
      setStatus('unavailable');
      return;
    }

    if (!res.ok) {
      clearTimeout(timer);
      try {
        await res.json();
      } catch {
        // Drop the JSON we can't parse — the unavailable copy on the
        // card is the operator-facing signal either way.
      }
      if (!mountedRef.current) return;
      setStatus('unavailable');
      return;
    }

    if (!res.body) {
      clearTimeout(timer);
      if (!mountedRef.current) return;
      setStatus('unavailable');
      return;
    }

    if (!mountedRef.current) {
      clearTimeout(timer);
      ac.abort(new Error('unmount'));
      return;
    }
    setStatus('streaming');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let buffer = '';

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const events: string[] = [];
        let cursor = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          if (buffer[i] === '\n') {
            const slice = buffer.slice(cursor, i);
            const isBlank = slice.trim().length === 0;
            if (!isBlank) {
              events.push(slice);
            }
            cursor = i + 1;
            if (buffer[cursor] === '\n') cursor += 1;
          }
        }
        buffer = buffer.slice(cursor);

        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]' || payload === '') continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: unknown } }>;
            };
            const chunk = json?.choices?.[0]?.delta?.content;
            if (typeof chunk === 'string' && chunk.length > 0) {
              setText((prev) => prev + chunk);
            }
          } catch {
            // Skip unparseable frames — the next chunk will arrive
            // with the bytes the parser needs.
          }
        }
      }
      decoder.decode();
      if (mountedRef.current) setStatus('done');
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') {
        setStatus(text ? 'done' : 'idle');
        return;
      }
      setStatus('unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  function dismiss() {
    abortRef.current?.abort(new Error('user_dismiss'));
    if (status === 'streaming') {
      setStatus('done');
    } else if (status === 'done') {
      setText('');
      setStatus('idle');
    } else if (status === 'unavailable') {
      setStatus('idle');
    }
  }

  async function copySummary() {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const ok = await copyToClipboard(trimmed);
    if (!mountedRef.current) return;
    if (ok) {
      toast.success('Summary copied.');
    } else {
      toast.error('Copy not supported in this browser.');
    }
  }

  const canCopy = text.trim().length > 0;

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              Stakeholder summary
            </CardDescription>
            <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
              <Sparkles className="size-4 text-brand-500" aria-hidden />
              AI executive brief
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status === 'streaming' ? (
              <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Streaming…
              </span>
            ) : null}
            {status === 'done' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={copySummary}
                disabled={!canCopy}
                aria-disabled={!canCopy}
              >
                <Copy className="size-4" aria-hidden /> Copy summary
              </Button>
            ) : null}
            {status !== 'idle' ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={dismiss}
                aria-label={
                  status === 'streaming'
                    ? 'Dismiss stakeholder summary'
                    : 'Reset stakeholder summary'
                }
              >
                {status === 'streaming' ? (
                  'Dismiss'
                ) : (
                  <>
                    <X className="size-4" aria-hidden /> Reset
                  </>
                )}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => void stream()}>
                <Sparkles className="size-4" aria-hidden /> Generate stakeholder summary
              </Button>
            )}
          </div>
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          Plain-English summary for leadership: what it means for the business, why it matters now,
          what to say first, and what to verify post-fix.
        </CardDescription>
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
      <CardContent className="flex flex-col gap-3">
        {status === 'idle' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            Click Generate to stream a fresh, AI-written paragraph aimed at non-technical leadership
            — paste-ready for a Slack update, an exec briefing, or an incident report.
          </p>
        ) : status === 'loading' ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Connecting…
          </div>
        ) : status === 'unavailable' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            AI service temporarily unavailable. Click Generate to retry once the proxy is reachable.
          </p>
        ) : (
          <p
            data-testid="stakeholder-summary-text"
            className="max-w-prose whitespace-pre-line text-body leading-relaxed text-foreground"
          >
            {(text || (status === 'streaming' ? '' : '(no content)')).trim()}
          </p>
        )}

        <div className="border-t border-border/60 pt-3">
          <p className="max-w-prose text-caption text-muted-foreground">
            {status === 'done'
              ? 'Verify the closing-line items (scans run, logs reviewed) before marking the alert resolved.'
              : 'The brief grounds itself in the asset posture and the CVE description only — it does not invent log signals or customer-impact claims.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
