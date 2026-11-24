// @polsia:user-owned — Snooze card for the alert detail page. Renders the
// 1d / 7d / 30d window buttons and the active-stamp ("Snoozed until …,
// 6d 12h remaining"). POSTs to /api/alerts/[id]/snooze with the
// computed ISO timestamp; on failure, reverts and offers `onChanged()`
// so the parent can refetch the detail envelope.
//
// Mounts from `initialSnoozedUntil` and never issues its own GET — the
// parent re-passes the prop on every refetch so the card stays in lock
// step with the authoritative server snapshot. Local mutations are
// optimistic: flip the stamp first, POST second, revert + toast on 4xx/
// 5xx. The state derived from `snoozedUntil` is purely a UI projection;
// the server is the source of truth for the column.

'use client';

import { BellOff, Clock, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface SnoozeCardProps {
  alertId: string;
  initialSnoozedUntil: string | null;
  onChanged?: () => void;
}

const WINDOW_OPTIONS: ReadonlyArray<{
  key: '1d' | '7d' | '30d';
  label: string;
  caption: string;
  ms: number;
}> = [
  { key: '1d', label: '1 day', caption: 'Tomorrow', ms: 24 * HOUR_MS },
  { key: '7d', label: '7 days', caption: 'Next week', ms: 7 * DAY_MS },
  { key: '30d', label: '30 days', caption: 'Next month', ms: 30 * DAY_MS },
];

function formatTimestamp(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function formatRemaining(until: string, now: number): string {
  const target = Date.parse(until);
  if (Number.isNaN(target)) return '—';
  const diff = target - now;
  if (diff <= 0) return 'window elapsed — row will resurface';
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / HOUR_MS);
  if (days > 0) return `${days}d ${hours}h remaining`;
  const minutes = Math.floor((diff % HOUR_MS) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

export function SnoozeCard({ alertId, initialSnoozedUntil, onChanged }: SnoozeCardProps) {
  // Local mutation — diverges from `initialSnoozedUntil` while a snooze is
  // in flight or after a successful local stamp; the next refetch from
  // the parent (via `onChanged`) reconciles it with the server.
  const [snoozedUntil, setSnoozedUntil] = useState<string | null>(initialSnoozedUntil);
  const [pendingKey, setPendingKey] = useState<'1d' | '7d' | '30d' | 'clear' | null>(null);

  const active = useMemo(() => {
    if (!snoozedUntil) return null;
    const t = Date.parse(snoozedUntil);
    return Number.isNaN(t) ? null : { until: snoozedUntil, ts: t };
  }, [snoozedUntil]);

  async function applyUntil(nextUntil: string | null, key: '1d' | '7d' | '30d' | 'clear') {
    const previous = snoozedUntil;
    setSnoozedUntil(nextUntil);
    setPendingKey(key);
    try {
      await apiFetch(`/api/alerts/${alertId}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ until: nextUntil }),
      });
      if (key === 'clear') toast.success('Snooze cleared.');
      else toast.success(`Snoozed for ${WINDOW_OPTIONS.find((o) => o.key === key)?.caption}.`);
      onChanged?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Snooze failed.';
      toast.error(msg);
      // Revert + reconcile with the server so a transient failure doesn't
      // strand the card on a stale stamp.
      setSnoozedUntil(previous);
      onChanged?.();
    } finally {
      setPendingKey(null);
    }
  }

  function pickWindow(key: '1d' | '7d' | '30d') {
    const opt = WINDOW_OPTIONS.find((o) => o.key === key);
    if (!opt) return;
    const next = new Date(Date.now() + opt.ms).toISOString();
    void applyUntil(next, key);
  }

  function clearSnooze() {
    void applyUntil(null, 'clear');
  }

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Silence
        </CardDescription>
        <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
          <Clock className="size-4 text-brand-500" aria-hidden />
          Snooze this alert
        </CardTitle>
        <CardDescription className="text-caption text-muted-foreground">
          Hide this CVE from the alerts list for a window of time. The row returns automatically
          when the window elapses; hit Un-snooze any time to bring it back sooner.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {active ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2"
            data-testid="snooze-active-stamp"
          >
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
                <BellOff className="size-3.5 text-brand-500" aria-hidden />
                Snoozed until {formatTimestamp(active.until)}
              </span>
              <span className="font-mono text-caption text-foreground">
                {formatRemaining(active.until, Date.now())}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={clearSnooze}
              disabled={pendingKey !== null}
              aria-disabled={pendingKey !== null}
            >
              {pendingKey === 'clear' ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Clearing…
                </>
              ) : (
                'Un-snooze'
              )}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {WINDOW_OPTIONS.map((opt) => {
            const isPending = pendingKey === opt.key;
            return (
              <Button
                key={opt.key}
                type="button"
                size="sm"
                variant={active ? 'outline' : 'default'}
                onClick={() => pickWindow(opt.key)}
                disabled={pendingKey !== null}
                aria-disabled={pendingKey !== null}
              >
                {isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Snoozing…
                  </>
                ) : (
                  <>Silence for {opt.label}</>
                )}
              </Button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
