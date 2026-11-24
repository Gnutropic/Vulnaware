// @polsia:user-owned — Per-user "Receive daily digest" preferences
// card on /account. Single Card titled "Email notifications" with the
// three knobs the cron actually honours:
//
//   1. `<Switch>` bound to `digestEnabled` — global on/off.
//   2. `<Select>` bound to `severityThreshold` — inclusive-lower
//      severities the digest includes; `null` = "all severities".
//   3. `<AlertsAssetChipRow>` bound to `assetScope` — composite
//      `${host}:${port}/${protocol}` set; empty = "all assets on
//      the team" (no narrowing).
//
// Plus two context lines:
//   - "Last updated …" mirrors the server-stamped `updatedAt` so the
//     visitor sees a Save success stamp without a refresh.
//   - "Last sent at …" mirrors the server-stamped `lastSentAt` so the
//     visitor can sanity-check the cron's last run.
//
// Pattern mirrors AccountWebhookSection (src/components/custom/account/
// webhook-section.tsx) — local state for the five knobs, audit-
// friendly fetch+mount on first render, reload after every successful
// PUT so the `updatedAt` (and `lastSentAt`) survives. Save is partial:
// the UI sends only the keys whose defaults changed.
//
// Failure posture:
//   - Local state for `digestEnabled` / `severityThreshold` /
//     `assetScope` / `lastSentAt` / `updatedAt` / `loading` /
//     `saving` / `topError`.
//   - On mount, reads `/api/account/digest` via `apiFetch` with the
//     shared zod contract AND `/api/alerts/asset-options` for the
//     chip-row source. A first-time read upserts defaults
//     (`digestEnabled: true`, `severityThreshold: null`,
//     `assetScope: []`) — see /api/account/digest GET.
//   - On save (PUT), the section re-fetches the GET so the
//     `updatedAt` survives back into local state.

'use client';

import { Bell, BellOff, Filter, Loader2, Save, ShieldCheck } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertsAssetChipRow } from '@/components/dashboard/alerts-asset-chip-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api-client';
import { type AssetFilterOption, AssetFilterOptions } from '@/lib/contracts/alerts';
import {
  DigestPrefsGetResponse,
  DigestPrefsItem,
  DigestPrefsSetBody,
  DigestPrefsSetResponse,
  SEVERITY_THRESHOLD_VALUES,
  type SeverityThreshold,
} from '@/lib/contracts/digest-prefs';

// Placeholder Select value for "no threshold — all severities". Radix
// Select's `value` must be a non-empty string; the `__all__` string is
// distinct from any SeverityThreshold value so assetScope round-trips
// don't get confused with a real threshold.
const ALL_SEVERITIES_VALUE = '__all__';

const SEVERITY_LABELS: Record<SeverityThreshold, string> = {
  critical: 'Critical and up',
  high: 'High and up',
  medium: 'Medium and up',
  low: 'Low and up',
};

const SAMPLE_DIGEST_PREVIEW = `[
  critical] on 10.0.0.7 — CVE-2026-0042 (link to /alerts/<id>)
[high]     on 10.0.0.7 — CVE-2026-0043 (link to /alerts/<id>)
…
Critical: 1   High: 2   Medium: 4   Low: 0`;

function formatTimestamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

function severityTriggerLabel(threshold: string | null): string {
  if (threshold == null) return 'All severities';
  const key = threshold.toLowerCase();
  if (key === 'critical' || key === 'high' || key === 'medium' || key === 'low') {
    return SEVERITY_LABELS[key];
  }
  return 'All severities';
}

interface DigestSectionState {
  digestEnabled: boolean;
  severityThreshold: string | null;
  assetScope: Set<string>;
  lastSentAt: string | null;
  updatedAt: string | null;
}

const INITIAL_STATE: DigestSectionState = {
  digestEnabled: true,
  severityThreshold: null,
  assetScope: new Set<string>(),
  lastSentAt: null,
  updatedAt: null,
};

export function DailyDigestToggleSection() {
  const [digestEnabled, setDigestEnabled] = useState(INITIAL_STATE.digestEnabled);
  const [severityThreshold, setSeverityThreshold] = useState<string | null>(
    INITIAL_STATE.severityThreshold,
  );
  const [assetScope, setAssetScope] = useState<Set<string>>(new Set<string>());
  const [lastSentAt, setLastSentAt] = useState<string | null>(INITIAL_STATE.lastSentAt);
  const [updatedAt, setUpdatedAt] = useState<string | null>(INITIAL_STATE.updatedAt);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const [assetOptions, setAssetOptions] = useState<AssetFilterOption[]>([]);

  const reload = useCallback(async () => {
    const cfg = await apiFetch('/api/account/digest', { schema: DigestPrefsGetResponse });
    setDigestEnabled(cfg.digestEnabled);
    setSeverityThreshold(cfg.severityThreshold);
    setAssetScope(new Set(cfg.assetScope));
    setLastSentAt(cfg.lastSentAt);
    setUpdatedAt(cfg.updatedAt);
    return cfg;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tasks = [
      reload()
        .catch((err) => {
          if (cancelled) return;
          setTopError(err instanceof Error ? err.message : 'Failed to load digest preferences.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        }),
      apiFetch('/api/alerts/asset-options', { schema: AssetFilterOptions })
        .then((res) => {
          if (cancelled) return;
          setAssetOptions(res.items);
        })
        .catch(() => {
          // Asset options source is decorative — a stale chip row is
          // recoverable on the next reload. Don't surface a toast here
          // because the main prefs payload is the truth.
          if (!cancelled) setAssetOptions([]);
        }),
    ];
    void Promise.all(tasks);
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Radix Select value (non-nullable). Server may have null → render
  // ALL_SEVERITIES_VALUE; on user pick convert back into a real
  // SeverityThreshold | null.
  const severitySelectValue = severityThreshold ?? ALL_SEVERITIES_VALUE;

  const severityLifted =
    SEVERITY_THRESHOLD_VALUES.find((v) => v === (severityThreshold ?? '').toLowerCase()) ?? null;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    const sortedAssetScope: string[] = Array.from(assetScope).sort((a, b) => a.localeCompare(b));
    const body = DigestPrefsSetBody.safeParse({
      digestEnabled,
      severityThreshold,
      assetScope: sortedAssetScope,
    });
    if (!body.success) {
      setTopError('Could not save — preference values are invalid.');
      return;
    }
    setSaving(true);
    try {
      const result = await apiFetch('/api/account/digest', {
        method: 'PUT',
        body: JSON.stringify(body.data),
        schema: DigestPrefsSetResponse,
      });
      const verified = DigestPrefsItem.parse(result);
      setDigestEnabled(verified.digestEnabled);
      setSeverityThreshold(verified.severityThreshold);
      setAssetScope(new Set(verified.assetScope));
      setLastSentAt(verified.lastSentAt);
      setUpdatedAt(verified.updatedAt);
      toast.success(
        verified.digestEnabled ? 'Daily digest preferences saved.' : 'Daily digest disabled.',
      );
      await reload();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Could not save the digest preference.');
      toast.error('Could not save the digest preference.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-border/80 bg-card shadow-md">
      <CardHeader className="gap-3">
        <p className="text-eyebrow text-brand-500">Email notifications</p>
        <CardTitle className="font-display text-h3 tracking-tight text-foreground">
          Receive daily digest
        </CardTitle>
        <CardDescription className="text-body text-muted-foreground">
          Each weekday at 08:30 UTC we email you a summary of NEW alerts that are open, owned by you
          (or are unassigned and waiting to be picked up), and match the severities and assets
          below. One envelope per UTC day — disable this toggle to opt out entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form
          onSubmit={handleSave}
          className="grid gap-5 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <Label htmlFor="account-digest-toggle" className="text-body font-medium">
                Daily digest
              </Label>
              <p className="text-caption text-muted-foreground">
                {digestEnabled
                  ? 'You will receive one envelope per UTC day, scoped below.'
                  : 'Off — no daily digest emails will be sent.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {digestEnabled ? (
                <Bell className="size-4 text-brand-500" aria-hidden />
              ) : (
                <BellOff className="size-4 text-muted-foreground" aria-hidden />
              )}
              <Switch
                id="account-digest-toggle"
                checked={digestEnabled}
                onCheckedChange={setDigestEnabled}
                disabled={loading || saving}
                aria-label="Receive daily digest"
              />
              <Badge variant={digestEnabled ? 'default' : 'outline'} className="font-normal">
                {digestEnabled ? 'On' : 'Off'}
              </Badge>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="account-digest-severity" className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-brand-500" aria-hidden />
              Severity threshold
            </Label>
            <Select
              value={severitySelectValue}
              onValueChange={(next) => {
                if (next === ALL_SEVERITIES_VALUE) {
                  setSeverityThreshold(null);
                  return;
                }
                const lifted = SEVERITY_THRESHOLD_VALUES.find((v) => v === next.toLowerCase());
                setSeverityThreshold(lifted ?? null);
              }}
              disabled={!digestEnabled || loading || saving}
            >
              <SelectTrigger
                id="account-digest-severity"
                aria-label="Severity threshold"
                className="w-full sm:w-[260px]"
              >
                <SelectValue placeholder={severityTriggerLabel(severityThreshold)} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SEVERITIES_VALUE}>All severities</SelectItem>
                {SEVERITY_THRESHOLD_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {SEVERITY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">
              {severityLifted == null
                ? `Includes critical, high, medium, and low — same as /alerts with no severity filter.`
                : `Includes ${SEVERITY_LABELS[severityLifted].toLowerCase()} — fewer digests, sharper focus.`}
            </p>
          </div>

          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Filter className="size-4 text-brand-500" aria-hidden />
              Asset scope
            </Label>
            <p className="text-caption text-muted-foreground">
              {assetScope.size === 0
                ? 'No assets selected — every open alert on your team lands in the digest.'
                : `${assetScope.size} asset${assetScope.size === 1 ? '' : 's'} selected — open alerts on these hosts/services only.`}
            </p>
            {loading ? (
              <div className="text-caption text-muted-foreground/80">Loading assets…</div>
            ) : (
              <AlertsAssetChipRow
                value={assetScope}
                onChange={(next) => setAssetScope(next ?? new Set<string>())}
                options={assetOptions}
              />
            )}
          </div>

          {updatedAt ? (
            <p className="font-mono text-caption text-muted-foreground/80">
              Last updated {formatTimestamp(updatedAt)}
            </p>
          ) : null}

          {lastSentAt ? (
            <p className="font-mono text-caption text-muted-foreground/80">
              Last sent at {formatTimestamp(lastSentAt)} UTC
            </p>
          ) : (
            <p className="text-caption text-muted-foreground/80">
              No digest sent yet — the next 08:30 UTC tick will dispatch your first envelope.
            </p>
          )}

          {topError ? (
            <p className="text-caption text-destructive" role="alert">
              {topError}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="submit" disabled={saving || loading}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" aria-hidden /> Save
                </>
              )}
            </Button>
          </div>
        </form>

        <details className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5">
          <summary className="flex cursor-pointer items-center gap-2 text-body font-medium text-foreground">
            What the daily digest looks like
          </summary>
          <div className="mt-4 grid gap-3">
            <p className="text-caption text-muted-foreground">
              Each day at 08:30 UTC, opted-in users receive a single envelope with a per-severity
              count summary, the window bounds (UTC), and the top critical + high rows linking back
              to each alert&apos;s detail page. Empty days are skipped silently — no envelope, no
              stamp.
            </p>
            <pre className="overflow-x-auto rounded-[var(--radius)] border border-border bg-background p-3 font-mono text-caption text-foreground">
              <code>{SAMPLE_DIGEST_PREVIEW}</code>
            </pre>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
