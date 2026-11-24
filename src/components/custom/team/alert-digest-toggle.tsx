// @polsia:user-owned — Per-workspace toggle for the daily alert digest.
// Reads/writes exclusively through /api/team/settings (apiFetch + zod
// contract). Member-level read so the toggle UI mounts for every team
// member; admin-level write so non-admin flips land a 403 from the
// route instead of mutating the workspace. The label renders the last-
// digest stamp (or "Never") so the visitor has visible confirmation
// that the cron has fired.
//
// Server-Components-avoidance posture: this island imports only
// @/lib/api-client and @/lib/contracts/team-settings; the GET/PATCH
// handlers under /api/team/settings own the DB read/write so no
// `await prisma` reaches a RSC.

'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api-client';
import { TeamSettings, type TeamSettingsPatch } from '@/lib/contracts/team-settings';

interface AlertDigestToggleProps {
  /** Optional className forwarded to the wrapper for layout passes. */
  className?: string;
}

function formatStampedAt(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function AlertDigestToggle({ className }: AlertDigestToggleProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [lastAlertDigestAt, setLastAlertDigestAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const current = await apiFetch('/api/team/settings', { schema: TeamSettings });
      setDigestEnabled(current.digestEnabled);
      setLastAlertDigestAt(current.lastAlertDigestAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load digest settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onCheckedChange = useCallback(
    async (next: boolean) => {
      const previous = digestEnabled;
      setSaving(true);
      setError(null);
      setDigestEnabled(next);
      try {
        const body: TeamSettingsPatch = { digestEnabled: next };
        const updated = await apiFetch('/api/team/settings', {
          method: 'PATCH',
          body: JSON.stringify(body),
          schema: TeamSettings,
        });
        setLastAlertDigestAt(updated.lastAlertDigestAt);
      } catch (err) {
        // Revert the optimistic flip so the UI reflects the route's
        // truth — non-admin callers see a 403, parse failures a 400, etc.
        setDigestEnabled(previous);
        const cause =
          err instanceof Error && 'cause' in err
            ? (err as Error & { cause: unknown }).cause
            : undefined;
        const detail =
          cause && typeof cause === 'object' && 'error' in cause
            ? String((cause as { error: unknown }).error)
            : err instanceof Error
              ? err.message
              : 'Could not save digest settings.';
        setError(detail);
      } finally {
        setSaving(false);
      }
    },
    [digestEnabled],
  );

  return (
    <div
      className={
        className ?? 'rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md'
      }
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="grid gap-2">
          <p className="text-h4 text-foreground">Daily alert digest</p>
          <p className="max-w-prose text-body text-muted-foreground">
            At 07:00 UTC, email the active members of this workspace a one-page summary of every
            open critical or high alert from the last 24 hours. When no alerts qualify, send a short
            all-clear note. Pause here stops the cron for this workspace only.
          </p>
          <p className="text-caption text-muted-foreground">
            Last digest: {loading ? 'Loading…' : formatStampedAt(lastAlertDigestAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {loading || saving ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          ) : null}
          <Switch
            checked={digestEnabled}
            onCheckedChange={onCheckedChange}
            disabled={loading || saving}
            aria-label="Enable daily alert digest"
          />
        </div>
      </div>
      {error ? (
        <p className="mt-3 text-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
