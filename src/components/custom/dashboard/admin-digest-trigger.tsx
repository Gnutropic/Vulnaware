// @polsia:user-owned — Client island for /admin/digest. Fetches the
// 10 most-recent DigestLog rows for the caller's team and exposes a
// button that POSTs to /api/admin/digest/run. On submit the island
// optimistically prepends the returned row's id+counts to its row
// list so the admin sees their own historical entry immediately.
//
// Server-Components-avoidance posture: this island imports ONLY
// @/lib/api-client + @/lib/contracts/digest. NO @/lib/db, NO
// server-only. The schemas are the single source of truth under
// /api/admin/digest/**.

'use client';

import { Loader2, SendHorizonal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  WeeklyDigestLogList,
  type WeeklyDigestLogRow,
  WeeklyDigestRunResult,
} from '@/lib/contracts/digest';

function formatStampedAt(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function formatShort(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 10)}`;
}

function statusVariant(
  status: WeeklyDigestLogRow['status'],
): 'default' | 'outline' | 'destructive' {
  if (status === 'sent') return 'default';
  if (status === 'partial') return 'outline';
  return 'destructive';
}

function triggeredByLabel(t: WeeklyDigestLogRow['triggeredBy']): string {
  return t === 'cron' ? 'cron' : 'manual';
}

export function AdminDigestTrigger() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<WeeklyDigestLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/admin/digest', { schema: WeeklyDigestLogList });
      setRows(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load digest log.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiFetch('/api/admin/digest/run', {
        method: 'POST',
        body: JSON.stringify({}),
        schema: WeeklyDigestRunResult,
      });

      if (result.id) {
        // Optimistic prepend — the GET /api/admin/digest read happens
        // on mount so a fresh manual insert should land at the top of
        // the table immediately. We only optimistically-prepend when
        // we know the row's id; otherwise a soft toast tells the
        // admin nothing changed.
        const fresh: WeeklyDigestLogRow = {
          id: result.id,
          weekStart: result.weekStart,
          status:
            result.failed === 0 && result.sent > 0
              ? result.sent > 0
                ? 'sent'
                : 'failed'
              : result.failed > 0
                ? 'partial'
                : 'sent',
          triggeredBy: 'manual',
          summarySubject: result.id
            ? `[digest] manual #${result.id.slice(0, 6)}`
            : '[digest] manual',
          recipientCount: result.attempted,
          createdAt: new Date().toISOString(),
        };
        setRows((prev) => [fresh, ...(prev ?? [])]);
        toast.success(
          `Sent to ${result.sent} member${result.sent === 1 ? '' : 's'}${result.failed > 0 ? ` (${result.failed} failed)` : ''}.`,
        );
      } else {
        toast.message('No recipients or content to send this week.');
      }
    } catch (err) {
      const cause =
        err instanceof Error && 'cause' in err
          ? (err as Error & { cause: unknown }).cause
          : undefined;
      const detail =
        cause && typeof cause === 'object' && 'error' in cause
          ? String((cause as { error: unknown }).error)
          : err instanceof Error
            ? err.message
            : 'Could not send the digest.';
      setError(detail);
      toast.error('Could not send the weekly digest.');
    } finally {
      setSubmitting(false);
    }
  }, []);

  return (
    <div className="grid gap-6">
      <section className="grid gap-3 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-h4 text-foreground">Trigger a digest now</p>
            <p className="max-w-prose text-body text-muted-foreground">
              Sends to every active member of this workspace in the next ~30 seconds. The inserted
              row appears in the log below with{' '}
              <code className="font-mono text-caption">manual</code> on the triggered-by chip.
            </p>
          </div>
          <Button type="button" onClick={() => void onSubmit()} disabled={submitting || loading}>
            {submitting ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <SendHorizonal aria-hidden className="size-4" />
                Send digest now
              </>
            )}
          </Button>
        </div>
        {error ? (
          <p className="text-caption text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="recent-digests" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-digests" className="text-h3 text-foreground">
            Recent digests
          </h2>
          <p className="text-caption text-muted-foreground">
            Newest 10 entries for this workspace.
          </p>
        </div>

        {loading ? (
          <div className="grid gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-[var(--radius-lg)] border border-border bg-card"
                aria-hidden
              />
            ))}
          </div>
        ) : rows && rows.length > 0 ? (
          <ul className="divide-y divide-border rounded-[var(--radius-lg)] border border-border bg-card">
            {rows.map((row) => (
              <li key={row.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="grid gap-1">
                  <p className="truncate text-body font-medium text-foreground">
                    {row.summarySubject}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    Week of {formatShort(row.weekStart)} · {formatStampedAt(row.createdAt)} ·{' '}
                    {row.recipientCount} recipient
                    {row.recipientCount === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(row.status)} className="w-fit uppercase">
                    {row.status}
                  </Badge>
                  <Badge variant="outline" className="w-fit">
                    {triggeredByLabel(row.triggeredBy)}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-border bg-card p-6 text-center">
            <p className="text-body text-muted-foreground">
              No digests have been sent for this workspace yet. The Monday-morning cron will write
              the first row, or hit <span className="font-medium">Send digest now</span> to fire one
              off-cycle.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
