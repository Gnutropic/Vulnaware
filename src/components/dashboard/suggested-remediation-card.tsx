// @polsia:user-owned — Per-alert streamed "Suggested remediation" client
// island. Sister island to explain-with-ai-card.tsx; calls POST
// /api/alerts/[id]/remediation/stream (raw fetch, NOT apiFetch, because
// the route returns an OpenAI-compatible SSE stream, not JSON), pumps
// the bytes through the same TextDecoder + `data:` splitting pattern,
// and renders the running text as a numbered list of concrete remediation
// steps once the stream closes.
//
// Why two surfaces (suggested-fix cached + remediation streamed):
// They serve different operator moments. The cached surface is the
// first-look checklist (regenerate button, per-step copy, refined
// over time). The streamed surface is the "give me a fresh walk-through
// RIGHT NOW" gesture — same shape, no cache, ready to be acted on.
//
// State machine (mirrors explain-with-ai-card.tsx verbatim):
//   - idle   → initial state. Click "Get remediation steps" starts the
//     stream.
//   - loading → POST in flight, headers not yet received.
//   - streaming → response ok; SSE pump appending deltas.
//   - done     → upstream closed cleanly; step list is final.
//   - unavailable → POST/streaming failed; user can retry.
//
// Closing note: the "Mark as resolved" footer carries an inline
// `<Textarea>` next to the CTA. The textarea is OPTIONAL — a blank
// resolve POSTs `{}` and the route stamps `closingNote: null` on the
// row. A non-empty note is trimmed server-side and rides the same
// close-stamp trio write as `status → 'resolved'`. Mirrors the FP
// dialog's per-row `.trim().min(0).max(500)` posture (here the route
// schema caps at 500 chars + customer-side `<Textarea maxLength={500}>`
// mirror the DB-side VARCHAR(500) cap).

'use client';

import { CheckCircle2, Copy, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AlertResolveResponse } from '@/lib/contracts/alerts';

interface SuggestedRemediationAsset {
  host: string;
  ip: string;
  port: number;
  protocol: string;
}

interface SuggestedRemediationCardProps {
  alertId: string;
  cveId: string;
  asset: SuggestedRemediationAsset;
  // Server-derived: detail.status === 'resolved' on the GET envelope.
  // Drives the initial disabled state of the "Mark as resolved" CTA so a
  // stale tab doesn't re-submit a row that's already resolved. Also
  // gates the "Reopen" CTA so it only surfaces on resolved rows — a
  // half-decision row (status === 'open' || 'in_progress') doesn't
  // need a reopen control.
  alreadyResolved: boolean;
  // Fires after a successful resolve mutation so the parent refetches
  // the detail envelope (mirrors SnoozeCard / AlertCommentsCard).
  onResolved?: () => void | Promise<void>;
  // Sibling to onResolved — fires after a successful reopen mutation so
  // the same parent refetch reconciles the visible statusChangedAt
  // stamp. Mirror of resolve to keep the two CTAs symmetric.
  onReopened?: () => void | Promise<void>;
}

type Status = 'idle' | 'loading' | 'streaming' | 'done' | 'unavailable';

const CLIENT_TIMEOUT_MS = 35_000;
const MAX_CLOSING_NOTE_CHARS = 500;

// Split the streamed accumulator into an ordered list of remediation
// steps. The platform prompt instructs the model to return one concrete
// action per newline (no closing prose, no text-booking headings), but
// we don't trust the model — strip leading numerals, dashes, stars, and
// bullets defensively.
function splitSteps(raw: string): string[] {
  const parts = raw
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/^[\s]*([-*•]+|\d+[.)])\s+/, '')
        .replace(/^#+\s*/, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
  return parts.slice(0, 6);
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

export function SuggestedRemediationCard({
  alertId,
  cveId,
  asset,
  alreadyResolved,
  onResolved,
  onReopened,
}: SuggestedRemediationCardProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [text, setText] = useState('');
  // Tracks the in-flight Mark-as-resolved POST. The CTA is disabled
  // while this is true so a stale click can't double-fire.
  const [resolvePending, setResolvePending] = useState(false);
  // Local mirror so the CTA can flip to "Resolved" without a refetch —
  // parent reconciles on the next detail GET via onResolved().
  const [resolved, setResolved] = useState(alreadyResolved);
  // Closing-note input — typed by the operator before clicking
  // "Mark as resolved". Trimmed + sent in the POST body only when
  // non-empty (a blank resolve omits the `note` key so the route
  // stamps `closingNote: null` on the row). Mirrors the FP dialog's
  // `.trim()` modal so a whitespace-only note 400s the empty-string
  // branch server-side as well.
  const [closingNote, setClosingNote] = useState('');
  // Tracks the in-flight Reopen POST. The CTA is disabled while this is
  // true so a stale click can't double-fire.
  const [reopenPending, setReopenPending] = useState(false);
  // Mirror drives the visible state of the Reopen CTA — flips to false
  // on a successful reopen, parent reconciles on the next detail GET
  // via onReopened(). Symmetric to `resolved` so the local mirrors form
  // a small state machine alongside the parent's server stamp.
  const [reopened, setReopened] = useState(false);
  // Reopen-reason input — typed by the operator before clicking the
  // Reopen CTA. Mirrors the closing-note composer: trimmed + sent in
  // the POST body only when non-empty, so a blank reopen (the modal
  // default) sends `{}` and the route stamps `reopenReason: null`.
  // Disabled while a Reopen POST is in flight so the input doesn't
  // drift from the in-flight read. `maxLength={500}` mirrors the
  // server-side VARCHAR(500) cap and zod's `AlertReopenBody.reason.max(500)`
  // round-trip.
  const [reopenReason, setReopenReason] = useState('');

  // Keeps state-machine transitions + AbortController handles across
  // re-renders. onUnmount tears the stream down so a navigated-away
  // tab never leaks a setState on a dead island.
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Resolve mutation's own AbortController — separate from the stream
  // pump so aborting one doesn't kill the other.
  const resolveAbortRef = useRef<AbortController | null>(null);
  // Reopen mutation's own AbortController — separate so an unmount or
  // a fast resolve→reopen flip never kills the in-flight reopen POST.
  const reopenAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort(new Error('unmount'));
      resolveAbortRef.current?.abort(new Error('unmount'));
      reopenAbortRef.current?.abort(new Error('unmount'));
    };
  }, []);

  useEffect(() => {
    // If the parent state flips the resolved flag (whether to true
    // after a refetch following a reopen, or back to false after a
    // refetch following a resolve), keep BOTH local mirrors aligned
    // so the next CTA flip can re-fire cleanly. `resolved` mirrors the
    // Mark-as-resolved state; `reopened` mirrors the Reopen mutation.
    setResolved(alreadyResolved);
    setReopened(false);
  }, [alreadyResolved]);

  async function stream() {
    if (status === 'loading' || status === 'streaming') return;
    setStatus('loading');
    setText('');

    const ac = new AbortController();
    abortRef.current = ac;
    const timer = setTimeout(() => ac.abort(new Error('client_timeout')), CLIENT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`/api/alerts/${alertId}/remediation/stream`, {
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

  async function copySteps() {
    const steps = splitSteps(text);
    if (steps.length === 0) return;
    const ok = await copyToClipboard(steps.join('\n'));
    if (!mountedRef.current) return;
    if (ok) {
      toast.success('Steps copied.');
    } else {
      toast.error('Copy not supported in this browser.');
    }
  }

  async function markResolved() {
    if (resolvePending || resolved) return;
    const ac = new AbortController();
    resolveAbortRef.current = ac;
    setResolvePending(true);
    // Optimistic local flip — the parent refetches via onResolved(),
    // which reconciles the visible chip with the server-authoritative
    // statusChangedAt timestamp.
    setResolved(true);
    // Trim the closing-note on the client BEFORE deciding to send
    // the `note` key. A blank / whitespace-only input produces a
    // POST `{}` body so the route stamps `closingNote: null` — NOT
    // a multi-column empty-string. Mirrors the FP dialog's
    // whitespace-handling so the two paths compose symmetrically.
    const trimmedNote = closingNote.trim();
    const body = trimmedNote.length > 0 ? { note: trimmedNote } : ({} as const);
    try {
      const res = await fetch(`/api/alerts/${alertId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: ac.signal,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setResolved(false);
        // Drain the body just so the connection doesn't leak unread
        // bytes; the toast is the operator-facing signal.
        try {
          await res.json();
        } catch {
          // ignore
        }
        if (!mountedRef.current) return;
        toast.error('Could not mark alert as resolved.');
        return;
      }
      try {
        const parsed = AlertResolveResponse.parse(await res.json());
        if (parsed.status !== 'resolved') {
          // Server-side re-read returned a different state than the
          // optimistic flip — possible race; revert the local mirror
          // and surface an error.
          setResolved(false);
          if (!mountedRef.current) return;
          toast.error('Could not mark alert as resolved.');
          return;
        }
      } catch {
        // A schema-drift on the envelope is a server-side bug, NOT a
        // user-actionable failure — revert + soft-fail.
        setResolved(false);
        if (!mountedRef.current) return;
        toast.error('Could not mark alert as resolved.');
        return;
      }
      toast.success('Alert resolved.');
      // Clear the closing-note input on the success path so a
      // subsequent resolve (after a reopen) starts from a clean slate
      // and a stale note doesn't leak into the next operator's
      // intent. The CardFooter remounts as-is, the `<Textarea>`
      // re-renders with `value=""`.
      setClosingNote('');
      // Parent refetch will reconcile acknowledgedAt /
      // statusChangedAt / closingNote with the authoritative server
      // stamp.
      await onResolved?.();
    } catch (err) {
      if (!mountedRef.current) return;
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setResolved(false);
        toast.error('Could not mark alert as resolved.');
      }
    } finally {
      if (mountedRef.current) setResolvePending(false);
    }
  }

  async function markReopened() {
    if (reopenPending || reopened || !alreadyResolved) return;
    const ac = new AbortController();
    reopenAbortRef.current = ac;
    setReopenPending(true);
    // Optimistic local flip — the parent refetches via onReopened(),
    // which reconciles the visible chip with the server-authoritative
    // statusChangedAt timestamp. Mirror of markResolved(): same shape,
    // status 'open' on the success branch, abort-safe revert on
    // thrown errors.
    setReopened(true);
    // Trim the reopen-reason on the client BEFORE deciding to send
    // the `reason` key. A blank / whitespace-only input produces a
    // POST `{}` body so the route stamps `reopenReason: null` —
    // mirroring how the closing-note composer handles its own
    // optional note, just inverted (the reopen composer mounts
    // IFF `alreadyResolved`, not on the resolve path).
    const trimmedReason = reopenReason.trim();
    const body = trimmedReason.length > 0 ? { reason: trimmedReason } : ({} as const);
    try {
      const res = await fetch(`/api/alerts/${alertId}/reopen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: ac.signal,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setReopened(false);
        try {
          await res.json();
        } catch {
          // ignore — drain only.
        }
        if (!mountedRef.current) return;
        toast.error('Could not reopen alert.');
        return;
      }
      try {
        // Parse against the widened AlertResolveResponse so the
        // response envelope's reopen trio lands on the parsed
        // value; schema-drift surfaces here rather than silently
        // shipping a degraded UI mirror.
        const parsed = AlertResolveResponse.parse(await res.json());
        if (parsed.status !== 'open') {
          // Possible race — revert the local mirror and surface an
          // error so the operator knows their click landed but the row
          // is in an unexpected state.
          setReopened(false);
          if (!mountedRef.current) return;
          toast.error('Could not reopen alert.');
          return;
        }
      } catch {
        setReopened(false);
        if (!mountedRef.current) return;
        toast.error('Could not reopen alert.');
        return;
      }
      toast.success('Alert reopened.');
      // Clear the reopen-reason input on the success path so a
      // subsequent reopen (after a re-resolve) starts from a clean
      // slate and a stale note doesn't leak into the next
      // operator's intent. Mirrors how the closing-note composer
      // clears its own input on the success path.
      setReopenReason('');
      // Parent refetch reconciles acknowledgedAt / statusChangedAt
      // / the reopen trio with the authoritative server stamp.
      await onReopened?.();
    } catch (err) {
      if (!mountedRef.current) return;
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setReopened(false);
        toast.error('Could not reopen alert.');
      }
    } finally {
      if (mountedRef.current) setReopenPending(false);
    }
  }

  const steps = splitSteps(text);
  const canCopy = steps.length > 0;
  // The CTA is disabled when (a) the user already optimistically
  // flipped to resolved, (b) the mutation is in flight, or (c) the
  // island has not yet finished streaming (so the operator goes from
  // "steps" → "confirmed resolved" without leaving a half-decision
  // behind).
  const resolveDisabled = resolved || resolvePending || status !== 'done';

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
              Suggested remediation
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
                onClick={copySteps}
                disabled={!canCopy}
                aria-disabled={!canCopy}
              >
                <Copy className="size-4" aria-hidden /> Copy steps
              </Button>
            ) : null}
            {status !== 'idle' ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={dismiss}
                aria-label={status === 'streaming' ? 'Dismiss remediation' : 'Reset remediation'}
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
                <Sparkles className="size-4" aria-hidden /> Get remediation steps
              </Button>
            )}
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
      <CardContent className="flex flex-col gap-4">
        {status === 'idle' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            Click Get steps to stream a fresh, AI-generated remediation checklist for this CVE —
            version lines, patch KB ids, and config flags you can paste straight into a runbook.
          </p>
        ) : status === 'loading' ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Connecting…
          </div>
        ) : status === 'unavailable' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            AI service temporarily unavailable. Get steps to retry once the proxy is reachable.
          </p>
        ) : steps.length > 0 ? (
          <ol className="flex flex-col gap-2" data-testid="suggested-remediation-steps">
            {steps.map((step) => (
              // The streamed model output rarely repeats; the trimmed
              // step text is a stable enough React key for the ≤ 6
              // lines we render. The cached-suggested-fix card takes
              // a sha256 of (title+body) for the same reason — we
              // mirror that pattern using the step text directly.
              <li
                key={step}
                className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-body text-foreground"
              >
                {step}
              </li>
            ))}
          </ol>
        ) : (
          <p className="max-w-prose text-body text-muted-foreground">
            {(text || 'Streaming…').trim() || '(no content)'}
          </p>
        )}

        {!alreadyResolved ? (
          // Closing-note composer — rides above the resolve CTA so the
          // operator can drop a one-liner before flipping state. The
          // textarea is OPTIONAL; a blank submit omits the `note` key
          // so the route stores NULL. `maxLength` mirrors the DB-side
          // VARCHAR(500) cap and the zod `AlertResolveBody.note.max(500)`
          // round-trip; disabled while a resolve POST is in flight so
          // the input doesn't drift from the in-flight read.
          <div
            className="flex flex-col gap-2 border-t border-border/60 pt-3"
            data-testid="closing-note-block"
          >
            <Label htmlFor="closing-note" className="text-eyebrow text-muted-foreground">
              Closing note (optional)
            </Label>
            <Textarea
              id="closing-note"
              value={closingNote}
              onChange={(e) => setClosingNote(e.target.value)}
              placeholder="What did you do to resolve this? (optional)"
              maxLength={MAX_CLOSING_NOTE_CHARS}
              disabled={resolvePending}
              rows={2}
              data-testid="closing-note-input"
            />
            <p className="text-caption text-muted-foreground">
              {closingNote.trim().length}/{MAX_CLOSING_NOTE_CHARS} characters
            </p>
          </div>
        ) : null}

        {alreadyResolved ? (
          // Reopen-reason composer — rides above the Reopen CTA so the
          // operator can drop a one-liner before flipping the row back
          // to `open`. Mounts only when `alreadyResolved` so a half-
          // decision row UI doesn't visibly fragment. The textarea is
          // OPTIONAL; a blank submit omits the `reason` key so the
          // route stores `reopenReason: NULL`. `maxLength` mirrors the
          // DB-side VARCHAR(500) cap and the zod
          // `AlertReopenBody.reason.max(500)` round-trip; disabled
          // while a Reopen POST is in flight so the input doesn't drift
          // from the in-flight read. Mirror of the closing-note
          // composer (which mounts on the resolve path) — same
          // posture with the polarity flipped.
          <div
            className="flex flex-col gap-2 border-t border-border/60 pt-3"
            data-testid="reopen-reason-block"
          >
            <Label htmlFor="reopen-reason" className="text-eyebrow text-muted-foreground">
              Reopen reason (optional)
            </Label>
            <Textarea
              id="reopen-reason"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Why is the alert back on the active queue? (optional)"
              maxLength={MAX_CLOSING_NOTE_CHARS}
              disabled={reopenPending}
              rows={2}
              data-testid="reopen-reason-input"
            />
            <p className="text-caption text-muted-foreground">
              {reopenReason.trim().length}/{MAX_CLOSING_NOTE_CHARS} characters
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
          <p className="max-w-prose text-caption text-muted-foreground">
            {alreadyResolved
              ? 'Reopen the alert to put it back on the active triage queue.'
              : 'Once these steps are in place, mark the alert as resolved to flip its triage state.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={resolved ? 'outline' : 'default'}
              onClick={() => void markResolved()}
              disabled={resolveDisabled}
              aria-disabled={resolveDisabled}
            >
              {resolvePending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Resolving…
                </>
              ) : resolved ? (
                <>
                  <CheckCircle2 className="size-4" aria-hidden /> Resolved
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4" aria-hidden /> Mark as resolved
                </>
              )}
            </Button>
            {alreadyResolved ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void markReopened()}
                disabled={reopenPending || reopened}
                aria-disabled={reopenPending || reopened}
              >
                {reopenPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Reopening…
                  </>
                ) : (
                  'Reopen'
                )}
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
