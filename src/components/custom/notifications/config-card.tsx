// @polsia:user-owned — Webhook URL config form. Reveal toggle (type=password ↔
// type=text), Copy affordance on the saved value, Save button that POSTs the
// `NotificationSetBody` to /api/team/notifications. Field errors and the top
// error banner are surfaced via local state (mirror api-keys/create-form.tsx).
//
// On Save success this card raises `onSaved` so the parent re-fetches the
// config + deliveries instead of duplicating state locally.

'use client';

import { Check, Copy, Eye, EyeOff, Loader2, Save } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { NotificationSetBody } from '@/lib/contracts/team-notifications';

const NotificationSetResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  webhookUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdByUserId: z.string().nullable(),
});

export interface NotificationConfigCardProps {
  initialUrl: string;
  onSaved: () => void;
}

function pickFirstMessage(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const val = (record as Record<string, unknown>)[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return undefined;
}

export function NotificationConfigCard({ initialUrl, onSaved }: NotificationConfigCardProps) {
  const [value, setValue] = useState(initialUrl);
  const [savedValue, setSavedValue] = useState(initialUrl);
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // If the parent's later refresh surfaces a different server-side URL
  // (e.g. another tab saved one), keep the editor in sync without clobbering
  // an in-progress edit.
  if (initialUrl !== savedValue && initialUrl !== value && !submitting) {
    setSavedValue(initialUrl);
    setValue(initialUrl);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    setFieldError(null);
    const localParse = NotificationSetBody.safeParse({ url: value.trim() });
    if (!localParse.success) {
      setFieldError('Enter a valid URL (https://…).');
      return;
    }
    setSubmitting(true);
    try {
      const result = await apiFetch('/api/team/notifications', {
        method: 'POST',
        body: JSON.stringify({ url: localParse.data.url }),
        schema: NotificationSetResponse,
      });
      setSavedValue(result.webhookUrl);
      toast.success('Webhook URL saved.');
      onSaved();
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause && typeof cause === 'object') {
        const errBody = (cause as { body?: unknown }).body;
        if (errBody && typeof errBody === 'object') {
          const errors = (errBody as { errors?: unknown }).errors;
          if (errors && typeof errors === 'object') {
            const first = pickFirstMessage(errors, 'url');
            if (typeof first === 'string') {
              setFieldError(first);
            } else {
              setTopError('Could not save the webhook URL.');
            }
          } else {
            const issues = (errBody as { issues?: { fieldErrors?: { url?: string[] } } }).issues;
            const urlIssue = issues?.fieldErrors?.url?.[0];
            setFieldError(urlIssue ?? 'Could not save the webhook URL.');
          }
        } else {
          setTopError(err instanceof Error ? err.message : 'Could not save the webhook URL.');
        }
      } else {
        setTopError(err instanceof Error ? err.message : 'Could not save the webhook URL.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function copySaved() {
    if (!savedValue) return;
    try {
      await navigator.clipboard.writeText(savedValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard — copy the URL manually.');
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md"
    >
      <div className="grid gap-2">
        <Label htmlFor="notification-url">Slack-compatible webhook URL</Label>
        <div className="flex items-stretch gap-2 overflow-hidden rounded-[var(--radius)] border border-border bg-background">
          <Input
            id="notification-url"
            type={reveal ? 'text' : 'password'}
            inputMode="url"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://hooks.slack.com/services/T0…/B0…/…"
            required
            maxLength={2048}
            className="flex-1 border-0 font-mono text-caption"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReveal((v) => !v)}
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
            onClick={copySaved}
            disabled={!savedValue}
            className="rounded-none border-0 border-l"
          >
            {copied ? (
              <>
                <Check className="size-4" aria-hidden /> Copied
              </>
            ) : (
              <>
                <Copy className="size-4" aria-hidden /> Copy
              </>
            )}
          </Button>
        </div>
        <p className="text-caption text-muted-foreground">
          Paste the HTTPS URL your chat provider gave you. We POST a small JSON payload (alert id,
          title, severity, deep link) when a critical alert lands.
        </p>
        {fieldError ? (
          <p className="text-caption text-destructive" role="alert">
            {fieldError}
          </p>
        ) : null}
      </div>

      {topError ? (
        <p className="text-caption text-destructive" role="alert">
          {topError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
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
  );
}
