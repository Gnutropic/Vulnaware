// @polsia:user-owned — Per-user DevSecOps integration webhook form on
// /account. Renders one Card titled "DevSecOps integration" with:
//
//   1. A short description paragraph.
//   2. An inline <details> documenting BOTH payloads — live alert
//      (snake_case keys + sample) and the test ping (`{ test: true }`).
//      Integrators can read the wire shape without leaving the page.
//   3. The URL input + Save flow — model on NotificationConfigCard (Input +
//      Reveal toggle + Save), but for the per-user endpoint. The plain
//      input + Reveal toggle pattern matches the team card; per-user
//      doesn't change the audience (security-adjacent users).
//   4. A "Send test" button NEXT TO the URL input row (§brief) — not below
//      the Save button. POSTs /api/account/webhook/test and renders the
//      same `{ ok, status, error }` shape as the test response zod schema.
//   5. A delivery-history card below the form. Hidden entirely when no
//      webhook is configured (matches the brief gate). Re-uses the
//      notifications panel's column vocabulary (Attempted / Target / Kind
//      / Response / Latency / Snippet) so a DevSecOps operator who reads
//      the team deliveries panel sees the same surface here.
//
// Failure posture:
//   - Local state for `url` / `savedUrl`. Initial mount fires `apiFetch`
//     against the route handler (the section reads data via the same
//     route the team card uses, just for the per-user resource).
//   - Field-level validation mirrors the team card: URL must parse + be
//     HTTPS. The route enforces the same rule server-side.
//   - On save success and on test success, the section RE-FETCHES
//     `/api/account/webhook` (not the PUT/POST response) so the
//     delivery-list reflects the latest server-stamped state, including
//     any new delivery row. Mirrors the notifications panel's reload
//     pattern.

'use client';

import { Check, Eye, EyeOff, Loader2, Save, Send, Terminal, Webhook } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import {
  UserWebhookConfigItem,
  type UserWebhookDeliveryItem,
  UserWebhookGetResponse,
  UserWebhookSetBody,
  UserWebhookTestResponse,
} from '@/lib/contracts/account-webhook';

const SAMPLE_LIVE_PAYLOAD = `{
  "alert_id": "alrt_abc123",
  "cve_id": "CVE-2024-1234",
  "severity": "critical",
  "title": "CVE-2024-1234",
  "target": "10.0.0.7:443/tcp",
  "url": "https://app.example.com/alerts/alrt_abc123",
  "owner_id": null,
  "created_at": "2026-07-30T08:15:00.000Z"
}`;

const SAMPLE_TEST_PAYLOAD = `{ "test": true }`;

function formatTimestamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function AccountWebhookSection() {
  const [url, setUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [deliveries, setDeliveries] = useState<UserWebhookDeliveryItem[]>([]);
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number | null;
    latencyMs: number;
    error: string | null;
  } | null>(null);

  // Re-fetch /api/account/webhook so the deliveries list mirrors the
  // server-stamped state (including any new delivery row written by the
  // Save wipe branch when the URL goes back to null). Mount + after every
  // successful Save / Send test — mirrors the notifications panel.
  const reload = useCallback(async () => {
    const cfg = await apiFetch('/api/account/webhook', { schema: UserWebhookGetResponse });
    setSavedUrl(cfg.url ?? '');
    setDeliveries(cfg.deliveries);
    return cfg;
  }, []);

  // Mount-time fetch: read the caller's saved config + deliveries. The
  // /account page already gates anonymous access, so a 401 here is
  // impossible in practice — but surface it as an error rather than
  // crashing.
  useEffect(() => {
    let cancelled = false;
    reload()
      .then((cfg) => {
        if (cancelled) return;
        // Sync the URL input to the saved value on first load so the
        // hidden password input shows the masked string the way the
        // initial GET returned it.
        setUrl(cfg.url ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        setTopError(err instanceof Error ? err.message : 'Failed to load webhook config.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    setFieldError(null);
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      // Empty input is the wipe case — PUT { url: null } clears the saved
      // column. Confirms before writing, then toasts "removed".
      setSaving(true);
      try {
        await apiFetch('/api/account/webhook', {
          method: 'PUT',
          body: JSON.stringify({ url: null }),
          schema: UserWebhookConfigItem,
        });
        setSavedUrl('');
        setUrl('');
        setTestResult(null);
        toast.success('Webhook URL removed.');
        // Re-fetch: the wipe clears savedUrl and the deliveries card
        // disappears (gated by cfg.url === null in the parent).
        await reload();
      } catch (err) {
        setTopError(err instanceof Error ? err.message : 'Could not remove the webhook URL.');
      } finally {
        setSaving(false);
      }
      return;
    }
    // Local pre-check mirrors the server's HTTPS gate so the user gets
    // immediate feedback before the round-trip.
    const localParsed = UserWebhookSetBody.safeParse({ url: trimmed });
    if (!localParsed.success) {
      setFieldError('Enter a valid HTTPS URL.');
      return;
    }
    try {
      const protocol = new URL(trimmed).protocol;
      if (protocol !== 'https:') {
        setFieldError('Webhook URL must use HTTPS.');
        return;
      }
    } catch {
      setFieldError('Enter a valid HTTPS URL.');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/api/account/webhook', {
        method: 'PUT',
        body: JSON.stringify({ url: trimmed }),
        schema: UserWebhookConfigItem,
      });
      setSavedUrl(trimmed);
      setUrl(trimmed);
      setTestResult(null);
      toast.success('Webhook URL saved.');
      await reload();
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause && typeof cause === 'object') {
        const errBody = (cause as { body?: unknown }).body;
        if (errBody && typeof errBody === 'object') {
          const body = errBody as Record<string, unknown>;
          const issues = body.issues as { fieldErrors?: { url?: string[] } } | undefined;
          const urlIssue = issues?.fieldErrors?.url?.[0];
          if (urlIssue) {
            setFieldError(urlIssue);
          } else if (typeof body.error === 'string') {
            setTopError(body.error);
          } else {
            setTopError(err instanceof Error ? err.message : 'Could not save the webhook URL.');
          }
        } else {
          setTopError(err instanceof Error ? err.message : 'Could not save the webhook URL.');
        }
      } else {
        setTopError(err instanceof Error ? err.message : 'Could not save the webhook URL.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestResult(null);
    setTopError(null);
    setFieldError(null);
    setTesting(true);
    try {
      const outcome = await apiFetch('/api/account/webhook/test', {
        method: 'POST',
        schema: UserWebhookTestResponse,
      });
      setTestResult({
        ok: outcome.ok,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        error: outcome.error,
      });
      if (outcome.ok) {
        toast.success('Test delivered.');
      } else {
        toast.error(outcome.error ?? 'Test failed.');
      }
      await reload();
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      const errBody =
        cause && typeof cause === 'object' ? (cause as { body?: unknown }).body : undefined;
      const msg =
        errBody && typeof errBody === 'object' && 'error' in errBody
          ? String((errBody as { error: unknown }).error)
          : err instanceof Error
            ? err.message
            : 'Test send failed.';
      setTestResult({ ok: false, status: null, latencyMs: 0, error: msg });
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  }

  const showDeliveries = savedUrl.length > 0;

  return (
    <Card className="border-border/80 bg-card shadow-md">
      <CardHeader className="gap-3">
        <p className="text-eyebrow text-brand-500">DevSecOps integration</p>
        <CardTitle className="font-display text-h3 tracking-tight text-foreground">
          Outbound webhook
        </CardTitle>
        <CardDescription className="text-body text-muted-foreground">
          {`Paste any HTTPS endpoint that accepts a JSON POST. When a new alert lands — regardless of
          severity — we deliver a small JSON payload to your URL. 4xx and 5xx responses are ignored
          silently with no retries.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form
          onSubmit={handleSave}
          className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5"
        >
          <div className="grid gap-2">
            <Label htmlFor="account-webhook-url">Webhook URL</Label>
            <div className="flex items-stretch gap-2 overflow-hidden rounded-[var(--radius)] border border-border bg-background">
              <Input
                id="account-webhook-url"
                type={reveal ? 'text' : 'password'}
                inputMode="url"
                autoComplete="off"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/security/webhook"
                disabled={loading}
                maxLength={2048}
                className="flex-1 border-0 font-mono text-caption"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReveal((v) => !v)}
                disabled={loading}
                className="rounded-none border-0 border-l"
                aria-label={reveal ? 'Hide webhook URL' : 'Reveal webhook URL'}
              >
                {reveal ? (
                  <>
                    <EyeOff className="size-4" aria-hidden /> Hide
                  </>
                ) : (
                  <>
                    <Eye className="size-4" aria-hidden /> Reveal
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={testing || loading || savedUrl.length === 0}
                className="rounded-none border-0 border-l"
              >
                {testing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Sending…
                  </>
                ) : (
                  <>
                    <Send className="size-4" aria-hidden /> Send test
                  </>
                )}
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              {savedUrl.length > 0
                ? `A previous URL is saved. Send test posts \`{ "test": true }\` to the SAVED value (not the input).`
                : 'No webhook is configured yet — save an HTTPS URL below to enable delivery.'}
            </p>
            {fieldError ? (
              <p className="text-caption text-destructive" role="alert">
                {fieldError}
              </p>
            ) : null}
            {topError ? (
              <p className="text-caption text-destructive" role="alert">
                {topError}
              </p>
            ) : null}
          </div>

          {testResult ? (
            <output
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-3 py-2"
              aria-live="polite"
            >
              <Badge variant={testResult.ok ? 'default' : 'destructive'}>
                {testResult.ok ? (
                  <>
                    <Check className="mr-1 size-3" aria-hidden /> Delivered
                  </>
                ) : (
                  'Failed'
                )}
              </Badge>
              <span className="font-mono text-caption text-foreground">
                status: {testResult.status ?? '—'}
              </span>
              <span className="font-mono text-caption text-foreground">
                latency: {testResult.latencyMs}ms
              </span>
              {testResult.error ? (
                <span className="text-caption text-destructive">{testResult.error}</span>
              ) : null}
            </output>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {savedUrl.length > 0 ? (
              <p className="font-mono text-caption text-muted-foreground/80">
                saved: {savedUrl.length > 36 ? `${savedUrl.slice(0, 36)}…` : savedUrl}
              </p>
            ) : null}
            <Button type="submit" disabled={saving || loading}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" aria-hidden />
                  {savedUrl.length > 0 ? 'Update' : 'Save'}
                </>
              )}
            </Button>
          </div>
        </form>

        {showDeliveries ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-h4 text-foreground">Delivery history</h3>
              <p className="text-caption text-muted-foreground">
                Last {deliveries.length} attempts — most recent first.
              </p>
            </div>
            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Attempted</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Response</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Snippet</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                          <Webhook className="size-4" aria-hidden />
                          No deliveries yet — clicking <strong className="ml-1">Send test</strong>{' '}
                          or surfacing a real alert will populate this list.
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    deliveries.map((row) => {
                      const ok =
                        row.responseCode != null &&
                        row.responseCode >= 200 &&
                        row.responseCode < 300;
                      const variant: 'default' | 'destructive' | 'secondary' = ok
                        ? 'default'
                        : row.responseCode != null
                          ? 'destructive'
                          : 'secondary';
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="font-mono text-caption text-muted-foreground">
                            {formatTimestamp(row.attemptedAt)}
                          </TableCell>
                          <TableCell className="font-mono text-caption text-muted-foreground">
                            {truncate(row.targetUrl || '—', 48)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={row.payloadKind === 'alert' ? 'secondary' : 'outline'}>
                              {row.payloadKind === 'alert' ? 'Alert' : 'Test'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={variant}>{row.responseCode ?? '—'}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-caption text-foreground">
                            {row.latencyMs}ms
                          </TableCell>
                          <TableCell className="max-w-[20rem] truncate font-mono text-caption text-muted-foreground">
                            {row.snippet ?? '—'}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

        <details className="rounded-[var(--radius-lg)] border border-border bg-muted/30 p-5">
          <summary className="flex cursor-pointer items-center gap-2 text-body font-medium text-foreground">
            <Terminal className="size-4 text-brand-500" aria-hidden />
            Wire format — what your endpoint receives
          </summary>
          <div className="mt-4 grid gap-4">
            <div>
              <p className="text-eyebrow text-brand-500">Live alert payload</p>
              <p className="mt-1 text-caption text-muted-foreground">
                POSTed every time a new alert lands for a team you belong to, regardless of
                severity. Snake_case keys; nullable fields always emitted (never omitted) so the
                schema stays constant for downstream automation.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-[var(--radius)] border border-border bg-background p-3 font-mono text-caption text-foreground">
                <code>{SAMPLE_LIVE_PAYLOAD}</code>
              </pre>
              <ul className="mt-3 grid list-disc gap-1 pl-5 text-caption text-muted-foreground">
                <li>
                  <span className="font-mono text-foreground">title</span> — never null; falls back
                  through any saved title hint → the CVE id → the alert id.
                </li>
                <li>
                  <span className="font-mono text-foreground">target</span> — flattened as{' '}
                  <span className="font-mono">host:port/protocol</span>;{' '}
                  <span className="font-mono">null</span> when no asset row exists.
                </li>
                <li>
                  <span className="font-mono text-foreground">owner_id</span> — the workspace member
                  who claimed the alert; <span className="font-mono">null</span> until a member
                  picks it up on the alert detail page.
                </li>
              </ul>
            </div>
            <div>
              <p className="text-eyebrow text-brand-500">Test payload</p>
              <p className="mt-1 text-caption text-muted-foreground">
                POSTed only when you click <strong className="font-medium">Send test</strong>.
                Identical transport + timeout posture as the live path; downstream log entries can
                grep <span className="font-mono">test</span> to distinguish real alerts from smoke
                tests.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-[var(--radius)] border border-border bg-background p-3 font-mono text-caption text-foreground">
                <code>{SAMPLE_TEST_PAYLOAD}</code>
              </pre>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
