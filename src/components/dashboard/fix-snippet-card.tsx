// @polsia:user-owned — Per-alert streamed "Fix preview" code-snippet
// client island. Sister island to stakeholder-summary-card.tsx +
// suggested-remediation-card.tsx; calls POST /api/alerts/[id]/fix-snippet/stream
// (raw fetch, NOT apiFetch, because the route returns an OpenAI-
// compatible SSE stream, not JSON), pumps the bytes through the same
// TextDecoder + `data:` splitting pattern, and renders the running
// text as fenced `<pre><code>` so the operator's paste preserves the
// exact byte layout (whitespace-pre, not whitespace-pre-wrap).
//
// Why a streamed-only "Fix preview" surface (no cached write-through):
// the cached suggested-fix surface already stores a step checklist;
// this card is the "give me a paste-ready code block RIGHT NOW"
// gesture. Streaming avoids an extra AlertCveFix column on every
// alert and keeps the snippet ephemeral — a future cached column is
// an iteration, not today.
//
// State machine (mirrors stakeholder-summary-card.tsx verbatim):
//   - idle   → initial state. Click "Generate fix preview" starts the
//     stream.
//   - loading → POST in flight, headers not yet received.
//   - streaming → response ok; SSE pump appending deltas.
//   - done     → upstream closed cleanly; snippet is final.
//   - unavailable → POST/streaming failed; user can retry.
//
// The Copy button lands on `done` and copies the trimmed, fence-
// stripped raw snippet (NOT the wrapped-fence form the model may
// emit) so the operator's `Cmd-V` lands a single paste-ready line.

'use client';

import { Copy, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface FixSnippetAsset {
  host: string;
  ip: string;
  port: number;
  protocol: string;
}

interface FixSnippetCardProps {
  alertId: string;
  cveId: string;
  asset: FixSnippetAsset;
}

type Status = 'idle' | 'loading' | 'streaming' | 'done' | 'unavailable';

const CLIENT_TIMEOUT_MS = 35_000;

// Defensive markdown-fence strip. Handles zero or one leading fence
// (with optional language: ` ``` `, ` ```dockerfile `, ` ```bash `) and
// zero or one trailing fence. The platform prompt asks the model to
// NOT emit fences, but the stream pump sees raw delta.content chunks
// that may be cut between fence lines, so the helper is fail-quiet —
// if a fence isn't there it leaves the input alone.
function stripFences(s: string): string {
  let out = s;
  // Leading ``` with optional language hint, on its own line.
  out = out.replace(/^```[a-zA-Z0-9_-]*\s*\n/, '');
  // Trailing ``` on its own line (with optional trailing whitespace).
  out = out.replace(/\n?```[ \t]*$/, '');
  return out;
}

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

export function FixSnippetCard({ alertId, cveId, asset }: FixSnippetCardProps) {
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
      res = await fetch(`/api/alerts/${alertId}/fix-snippet/stream`, {
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

  async function copySnippet() {
    // Copy the trimmed, fence-stripped raw snippet (NOT the wrapped-
    // fence form the model may emit) so the operator's Cmd-V lands a
    // single paste-ready line straight into a Dockerfile / package.json
    // / nginx.conf / Apache config / sshd_config / sysctl invocation /
    // shell command runbook.
    const trimmed = stripFences(text).trim();
    if (trimmed.length === 0) return;
    const ok = await copyToClipboard(trimmed);
    if (!mountedRef.current) return;
    if (ok) {
      toast.success('Snippet copied.');
    } else {
      toast.error('Copy not supported in this browser.');
    }
  }

  // Render-time text for the `<pre><code>` body: we render even on
  // `done` with the placeholder so the card never collapses to nothing
  // and the Copy button has a stable target.
  const renderedText = stripFences(
    text || (status === 'streaming' ? '' : '(no content)'),
  ).trimEnd();
  // What Copy actually ships to the user's clipboard: the trimmed,
  // fence-stripped raw snippet — never the wrapped-fence form a
  // stream chunk might emit.
  const copyTarget = stripFences(text).trim();
  const canCopy = copyTarget.length > 0;

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
              Fix preview
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
                onClick={copySnippet}
                disabled={!canCopy}
                aria-disabled={!canCopy}
              >
                <Copy className="size-4" aria-hidden /> Copy snippet
              </Button>
            ) : null}
            {status !== 'idle' ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={dismiss}
                aria-label={status === 'streaming' ? 'Dismiss fix preview' : 'Reset fix preview'}
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
                <Sparkles className="size-4" aria-hidden /> Generate fix preview
              </Button>
            )}
          </div>
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          Machine-pasteable code or config line you can drop straight into a Dockerfile,
          package.json, nginx.conf, Apache config, sshd_config, sysctl invocation, or shell command
          for this CVE.
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
            Click Generate to stream a fresh, AI-written paste-ready line — a package version bump,
            a Dockerfile RUN, an nginx server block, an Apache directive, an sshd_config toggle, a
            sysctl invocation, or a one-line shell command — keyed to this CVE and this asset.
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
          <pre
            data-testid="fix-snippet-code"
            className="overflow-x-auto whitespace-pre rounded-md border border-border/60 bg-muted/30 p-3"
          >
            <code className="font-mono text-body leading-relaxed text-foreground">
              {renderedText}
            </code>
          </pre>
        )}

        <div className="border-t border-border/60 pt-3">
          <p className="max-w-prose text-caption text-muted-foreground">
            The snippet is the exact lines to paste into a Dockerfile / package.json / nginx.conf /
            sshd_config / sysctl invocation / shell command for this CVE — verbatim from the model,
            stripped of any markdown fence so the paste lands the operator's intended bytes.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
