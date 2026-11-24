// @polsia:user-owned — GCP connection form island. Lets the operator add a
// new GCP connection: project id + service-account JSON + label + zones.

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
  type GcpConnectionCreate,
  type GcpConnectionItem,
  GcpConnectionItem as GcpConnectionItemSchema,
} from '@/lib/contracts/gcp';

const ZONE_RE = /^[a-z]+-[a-z]+\d+-[a-z]$/u;
const PROJECT_RE = /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/u;

function pickFirstMessage(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const val = (record as Record<string, unknown>)[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return undefined;
}

const SA_PLACEHOLDER = JSON.stringify(
  {
    type: 'service_account',
    project_id: '<your-project-id>',
    private_key_id: 'abcd…',
    private_key: 'REDACTED\\n',
    client_email: '<sa-name>@<your-project-id>.iam.gserviceaccount.com',
    client_id: '1234567890…',
  },
  null,
  2,
);

export function GcpConnectionForm({ onCreated }: { onCreated?: () => void }) {
  const [projectId, setProjectId] = useState('');
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [label, setLabel] = useState('');
  const [zonesInput, setZonesInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    setFields({});
    const zones = zonesInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        if (ZONE_RE.test(s)) return s;
        setFields((prev) => ({ ...prev, zones: `Zone ${s} is malformed (us-central1-a, …)` }));
        return '';
      })
      .filter((s) => s.length > 0);
    const payload: GcpConnectionCreate = {
      projectId: projectId.trim(),
      serviceAccountJson: serviceAccountJson.trim(),
      label: label.trim(),
      zones,
    };
    if (!PROJECT_RE.test(payload.projectId)) {
      setTopError('Project ID must look like my-gcp-project (6-30 chars, dashes, lowercase).');
      return;
    }
    if (payload.label.trim().length === 0) {
      setTopError('Label is required.');
      return;
    }
    if (payload.serviceAccountJson.length < 1) {
      setTopError('Service account JSON is required.');
      return;
    }
    // Local sanity check: parsed JSON's project_id must match the
    // connection's project id — the server zod schema enforces the same
    // thing and returns a 400 if it doesn't.
    try {
      const parsed = JSON.parse(payload.serviceAccountJson) as {
        project_id?: string;
        type?: string;
      };
      if (parsed.type !== 'service_account') {
        setTopError('JSON must be a service-account key (type === "service_account").');
        return;
      }
      if (parsed.project_id !== payload.projectId) {
        setTopError(
          `Service-account project_id (${parsed.project_id ?? 'missing'}) must match the connection's project id.`,
        );
        return;
      }
    } catch (err) {
      setTopError(
        `Service-account JSON is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    setIsSubmitting(true);
    try {
      const created: GcpConnectionItem = await apiFetch('/api/gcp/connections', {
        method: 'POST',
        body: JSON.stringify(payload),
        schema: GcpConnectionItemSchema,
      });
      toast.success(`GCP connection "${created.label}" saved.`);
      setProjectId('');
      setServiceAccountJson('');
      setLabel('');
      setZonesInput('');
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
        <Label htmlFor="gcp-conn-label">Label</Label>
        <Input
          id="gcp-conn-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Production project"
          maxLength={64}
          required
        />
        {fields.label ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.label}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="gcp-conn-project">Project ID</Label>
        <Input
          id="gcp-conn-project"
          type="text"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="my-gcp-project"
          required
        />
        {fields.projectId ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.projectId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="gcp-conn-sa">Service-account JSON</Label>
        <textarea
          id="gcp-conn-sa"
          value={serviceAccountJson}
          onChange={(e) => setServiceAccountJson(e.target.value)}
          rows={8}
          placeholder={SA_PLACEHOLDER}
          className="flex w-full rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-body font-mono text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          required
        />
        <p className="text-caption text-muted-foreground">
          <strong>Stored with your connection.</strong>{' '}
          {`${brand.name} keeps the full JSON so each run
          can mint a fresh OAuth2 token. Use a service account that has read-only access to the
          resources you want enumerated (Viewer role is sufficient).`}
        </p>
        {fields.serviceAccountJson ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.serviceAccountJson}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="gcp-conn-zones">Zones (comma-separated)</Label>
        <Input
          id="gcp-conn-zones"
          type="text"
          value={zonesInput}
          onChange={(e) => setZonesInput(e.target.value)}
          placeholder="us-central1-a, europe-west1-b"
        />
        <p className="text-caption text-muted-foreground">
          Leave empty to enumerate us-central1-a only. Up to 20 zones per connection.
        </p>
        {fields.zones ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.zones}
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
          Service-account auth · no workload identity setup
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
