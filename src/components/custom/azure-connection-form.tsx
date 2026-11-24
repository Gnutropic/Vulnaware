// @polsia:user-owned — Azure connection form island. Lets the operator add
// a new Azure connection: tenant id + client id + subscription id + client
// secret + locations. Uses apiFetch + the same zod contract the
// /api/azure/connections route validates.

'use client';

import { Cloud, Loader2, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import {
  type AzureConnectionCreate,
  type AzureConnectionItem,
  AzureConnectionItem as AzureConnectionItemSchema,
} from '@/lib/contracts/azure';

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function pickFirstMessage(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const val = (record as Record<string, unknown>)[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return undefined;
}

export function AzureConnectionForm({ onCreated }: { onCreated?: () => void }) {
  const [subscriptionId, setSubscriptionId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [label, setLabel] = useState('');
  const [locationsInput, setLocationsInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    setFields({});
    const locations = locationsInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const payload: AzureConnectionCreate = {
      subscriptionId: subscriptionId.trim(),
      tenantId: tenantId.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      label: label.trim(),
      locations,
    };
    if (!GUID_RE.test(payload.subscriptionId)) {
      setTopError('Subscription ID must look like a GUID.');
      return;
    }
    if (!GUID_RE.test(payload.tenantId)) {
      setTopError('Tenant ID must look like a GUID.');
      return;
    }
    if (!GUID_RE.test(payload.clientId)) {
      setTopError('Client ID must look like a GUID.');
      return;
    }
    if (payload.label.trim().length === 0) {
      setTopError('Label is required.');
      return;
    }
    if (payload.clientSecret.length < 1) {
      setTopError('Client secret is required.');
      return;
    }
    setIsSubmitting(true);
    try {
      const created: AzureConnectionItem = await apiFetch('/api/azure/connections', {
        method: 'POST',
        body: JSON.stringify(payload),
        schema: AzureConnectionItemSchema,
      });
      toast.success(`Azure connection "${created.label}" saved.`);
      setSubscriptionId('');
      setTenantId('');
      setClientId('');
      setClientSecret('');
      setLabel('');
      setLocationsInput('');
      onCreated?.();
    } catch (err) {
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
          if (Object.keys(fieldErrors).length > 0) {
            setFields(fieldErrors);
          } else {
            setTopError('Invalid request');
          }
        } else {
          setTopError(err instanceof Error ? err.message : 'Failed to save connection');
        }
      } else {
        setTopError(err instanceof Error ? err.message : 'Failed to save connection');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md"
    >
      <div className="grid gap-2">
        <Label htmlFor="azure-conn-label">Label</Label>
        <Input
          id="azure-conn-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Production subscription"
          maxLength={64}
          required
        />
        <p className="text-caption text-muted-foreground">
          A friendly name for this connection — typically the subscription display name.
        </p>
        {fields.label ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.label}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="azure-conn-subscription">Subscription ID</Label>
        <Input
          id="azure-conn-subscription"
          type="text"
          value={subscriptionId}
          onChange={(e) => setSubscriptionId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          required
        />
        {fields.subscriptionId ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.subscriptionId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="azure-conn-tenant">Tenant ID</Label>
        <Input
          id="azure-conn-tenant"
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="11111111-1111-1111-1111-111111111111"
          required
        />
        {fields.tenantId ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.tenantId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="azure-conn-client">Client ID</Label>
        <Input
          id="azure-conn-client"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="22222222-2222-2222-2222-222222222222"
          required
        />
        {fields.clientId ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.clientId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="azure-conn-secret">Client secret</Label>
        <Input
          id="azure-conn-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="••••••••"
          required
        />
        <p className="text-caption text-muted-foreground">
          <strong>Stored with your connection.</strong>{' '}
          {`${brand.name} keeps the secret alongside the
          tenant + client id so each run can mint a fresh OAuth token. Use a credential that has
          read-only access to the resources you want enumerated.`}
        </p>
        {fields.clientSecret ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.clientSecret}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="azure-conn-locations">Locations (comma-separated)</Label>
        <Input
          id="azure-conn-locations"
          type="text"
          value={locationsInput}
          onChange={(e) => setLocationsInput(e.target.value)}
          placeholder="eastus, westeurope"
        />
        <p className="text-caption text-muted-foreground">
          Leave empty to enumerate eastus only. Up to 20 locations per connection.
        </p>
        {fields.locations ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.locations}
          </p>
        ) : null}
      </div>

      {topError ? (
        <div
          className="flex items-center gap-2 rounded-[var(--radius)] border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive"
          role="alert"
        >
          <Cloud className="size-4" aria-hidden /> {topError}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Badge variant="outline" className="mr-auto">
          Service principal auth · no MSFBA / OAuth flow
        </Badge>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Saving…
            </>
          ) : (
            <>
              <Plus className="size-4" aria-hidden /> Add connection
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
