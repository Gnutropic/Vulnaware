// @polsia:user-owned — Create-key form island. Validates against the same
// `ApiKeyCreateBody` zod schema the route uses, surfaces server-side 400s
// onto the form, and renders the one-time plaintext in a copy-to-clipboard
// banner on success.

'use client';

import { Check, Copy, KeyRound, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { type ApiKeyCreateBody, ApiKeyCreateResponse } from '@/lib/contracts/api-key';

type ScopeKind = z.infer<typeof ApiKeyCreateBody>['scopeKind'];

interface CreatedResult {
  secret: string;
  name: string;
  scopeKind: ScopeKind;
  scanId: string | null;
}

function pickFirstMessage(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const val = (record as Record<string, unknown>)[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return undefined;
}

export function ApiKeyCreateForm({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState('');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('team');
  const [scanId, setScanId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResult | null>(null);
  const [copied, setCopied] = useState(false);

  function validateLocally(): string | null {
    if (name.trim().length === 0) return 'Name is required';
    if (name.length > 64) return 'Name is too long';
    if (scopeKind === 'scan' && scanId.length === 0) {
      return 'scanId is required for scan-scope keys';
    }
    if (scopeKind === 'scan' && !/^[A-Za-z0-9_-]+$/.test(scanId)) {
      return 'scanId must be alphanumeric with - or _';
    }
    if (scopeKind !== 'scan' && scanId.length > 0) {
      return 'scanId may only be set for scan-scope keys';
    }
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    setFields({});
    const localError = validateLocally();
    if (localError) {
      setTopError(localError);
      return;
    }
    setSubmitting(true);
    try {
      const result = await apiFetch('/api/v1/keys', {
        method: 'POST',
        body: JSON.stringify({
          name,
          scopeKind,
          scanId: scopeKind === 'scan' ? scanId : undefined,
        }),
        schema: ApiKeyCreateResponse,
      });
      setCreated({
        secret: result.secret,
        name: result.name,
        scopeKind: result.scopeKind,
        scanId: result.scanId ?? null,
      });
      setName('');
      setScanId('');
      setFields({});
      toast.success('API key created. Copy the secret now — it will not be shown again.');
      onCreated?.();
    } catch (err) {
      // The thrown error has a `cause` set by apiFetch to the parsed JSON body.
      // For 400 responses we surface field errors onto the form.
      const cause = (err as { cause?: unknown }).cause;
      if (cause && typeof cause === 'object') {
        const errBody = (cause as { body?: unknown }).body;
        const fieldErrors: Record<string, string> = {};
        if (errBody && typeof errBody === 'object') {
          const errors = (errBody as { errors?: unknown }).errors;
          if (errors && typeof errors === 'object') {
            for (const [field, value] of Object.entries(errors as Record<string, unknown>)) {
              const first = pickFirstMessage(value, '0');
              if (typeof first === 'string') fieldErrors[field] = first;
            }
          }
          // Fall through to top error if we didn't pick up any field errors.
          if (Object.keys(fieldErrors).length > 0) {
            setFields(fieldErrors);
          } else {
            setTopError('Invalid request');
          }
        } else {
          setTopError(err instanceof Error ? err.message : 'Failed to create key');
        }
      } else {
        setTopError(err instanceof Error ? err.message : 'Failed to create key');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard — copy the secret manually.');
    }
  }

  if (created) {
    return (
      <div className="grid gap-4 rounded-[var(--radius-lg)] border border-brand-200 bg-brand-50 p-5 shadow-md">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="size-4 text-brand-700" aria-hidden />
          <h3 className="text-h4 text-brand-900">Key created</h3>
          <Badge variant="secondary">{created.name}</Badge>
          <Badge variant="outline">
            {created.scopeKind === 'team' ? 'Team-wide' : (created.scanId ?? 'scan')}
          </Badge>
        </div>
        <p className="text-caption text-brand-800">
          Copy the secret now — it is shown only once and will not be retrievable later.
        </p>
        <div className="flex items-stretch gap-2 overflow-hidden rounded-[var(--radius)] border border-brand-200 bg-background">
          <code className="flex-1 overflow-x-auto px-3 py-2 font-mono text-caption text-foreground">
            {created.secret}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copySecret}
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
        <Button type="button" variant="ghost" onClick={() => setCreated(null)} className="w-fit">
          Create another key
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md"
    >
      <div className="grid gap-2">
        <Label htmlFor="api-key-name">Name</Label>
        <Input
          id="api-key-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          required
          placeholder="prod-ci-integration"
        />
        {fields.name ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.name}
          </p>
        ) : null}
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-caption font-medium text-foreground">Scope</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-background px-3 py-2">
            <input
              type="radio"
              name="scopeKind"
              value="team"
              checked={scopeKind === 'team'}
              onChange={() => setScopeKind('team')}
              className="mt-1"
            />
            <span>
              <span className="block text-body font-medium text-foreground">Team-wide</span>
              <span className="block text-caption text-muted-foreground">
                List and read every scan owned by your team.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-background px-3 py-2">
            <input
              type="radio"
              name="scopeKind"
              value="scan"
              checked={scopeKind === 'scan'}
              onChange={() => setScopeKind('scan')}
              className="mt-1"
            />
            <span>
              <span className="block text-body font-medium text-foreground">Single scan</span>
              <span className="block text-caption text-muted-foreground">
                Trigger and read one scan by id only.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {scopeKind === 'scan' ? (
        <div className="grid gap-2">
          <Label htmlFor="api-key-scanId">Scan id</Label>
          <Input
            id="api-key-scanId"
            type="text"
            value={scanId}
            onChange={(event) => setScanId(event.target.value)}
            pattern="^[A-Za-z0-9_-]+$"
            placeholder="cm0abc123def"
            required
          />
          <p className="text-caption text-muted-foreground">
            Required — paste the id of the scan this key should be limited to.
          </p>
          {fields.scanId ? (
            <p className="text-caption text-destructive" role="alert">
              {fields.scanId}
            </p>
          ) : null}
        </div>
      ) : null}

      {topError ? (
        <p className="text-caption text-destructive" role="alert">
          {topError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Creating…
            </>
          ) : (
            <>
              <KeyRound className="size-4" aria-hidden /> Create key
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
