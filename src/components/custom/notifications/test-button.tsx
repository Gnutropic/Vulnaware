// @polsia:user-owned — "Send test alert" affordance. POSTs the configured
// URL via /api/team/notifications/test, surfaces the typed outcome
// (`{ ok, status, latencyMs, error }`) inline as a small result row, and
// toasts on completion. After the request resolves it raises `onTested`
// so the parent re-fetches the deliveries ring buffer.

'use client';

import { Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { NotificationTestResponse } from '@/lib/contracts/team-notifications';

export interface NotificationTestButtonProps {
  onTested: () => void;
  disabled?: boolean;
}

export function NotificationTestButton({ onTested, disabled }: NotificationTestButtonProps) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    status: number | null;
    latencyMs: number;
    error: string | null;
  } | null>(null);

  async function handleClick() {
    setSubmitting(true);
    setResult(null);
    try {
      const outcome = await apiFetch('/api/team/notifications/test', {
        method: 'POST',
        schema: NotificationTestResponse,
      });
      setResult({
        ok: outcome.ok,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        error: outcome.error,
      });
      onTested();
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      const errBody =
        cause && typeof cause === 'object' ? (cause as { body?: unknown }).body : undefined;
      const errMessage =
        errBody && typeof errBody === 'object' && 'error' in errBody
          ? String((errBody as { error: unknown }).error)
          : err instanceof Error
            ? err.message
            : 'Test send failed';
      setResult({
        ok: false,
        status: null,
        latencyMs: 0,
        error: errMessage,
      });
      onTested();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="text-h4 text-foreground">Test send</h3>
          <p className="text-caption text-muted-foreground">
            Posts a synthetic critical alert to the configured URL and surfaces the upstream
            response.
          </p>
        </div>
        <Button type="button" onClick={handleClick} disabled={submitting || disabled}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Sending…
            </>
          ) : (
            <>
              <Send className="size-4" aria-hidden /> Send test alert
            </>
          )}
        </Button>
      </div>

      {result ? (
        <output
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 py-2"
          aria-live="polite"
        >
          <Badge variant={result.ok ? 'default' : 'destructive'}>
            {result.ok ? 'Delivered' : 'Failed'}
          </Badge>
          <span className="font-mono text-caption text-foreground">
            status: {result.status ?? '—'}
          </span>
          <span className="font-mono text-caption text-foreground">
            latency: {result.latencyMs}ms
          </span>
          {result.error ? (
            <span className="text-caption text-destructive">{result.error}</span>
          ) : null}
        </output>
      ) : null}
    </div>
  );
}
