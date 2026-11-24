// @polsia:user-owned — Connection form island. Lets the operator create a new
// cross-account AWS connection: role ARN + external id + regions to scan. Uses
// apiFetch + the same zod contract the /api/aws/connections route validates.

'use client';

import { Cloud, Loader2, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import {
  type AwsConnectionCreate,
  type AwsConnectionItem,
  AwsConnectionItem as AwsConnectionItemSchema,
} from '@/lib/contracts/aws';

type ConnectionInput = z.infer<typeof AwsConnectionCreate>;

function pickFirstMessage(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const val = (record as Record<string, unknown>)[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return undefined;
}

export function AwsConnectionForm({ onCreated }: { onCreated?: () => void }) {
  const [roleArn, setRoleArn] = useState('');
  const [externalId, setExternalId] = useState('');
  const [label, setLabel] = useState('');
  const [regionsInput, setRegionsInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);

  function validateLocally(input: ConnectionInput): string | null {
    if (!/^arn:(aws[a-z-]*)?:iam::\d{12}:role\/.+$/u.test(input.roleArn)) {
      return 'Role ARN must look like arn:aws:iam::123456789012:role/<name>.';
    }
    if (input.externalId.length < 2) return 'External id is required.';
    if (input.label.trim().length === 0) return 'Label is required.';
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTopError(null);
    setFields({});
    const regions = regionsInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const payload: AwsConnectionCreate = {
      roleArn: roleArn.trim(),
      externalId: externalId.trim(),
      label: label.trim(),
      regions,
    };
    const localError = validateLocally(payload);
    if (localError) {
      setTopError(localError);
      return;
    }
    setIsSubmitting(true);
    try {
      const created: AwsConnectionItem = await apiFetch('/api/aws/connections', {
        method: 'POST',
        body: JSON.stringify(payload),
        schema: AwsConnectionItemSchema,
      });
      toast.success(`AWS connection “${created.label}” saved.`);
      setRoleArn('');
      setExternalId('');
      setLabel('');
      setRegionsInput('');
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
        <Label htmlFor="aws-conn-label">Label</Label>
        <Input
          id="aws-conn-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Production account"
          maxLength={64}
          required
        />
        <p className="text-caption text-muted-foreground">
          A friendly name for this connection — for example, the AWS account alias or environment.
        </p>
        {fields.label ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.label}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="aws-conn-arn">Cross-account role ARN</Label>
        <Input
          id="aws-conn-arn"
          type="text"
          value={roleArn}
          onChange={(e) => setRoleArn(e.target.value)}
          placeholder="arn:aws:iam::123456789012:role/VulnAwareScanner"
          required
        />
        <p className="text-caption text-muted-foreground">
          {`The IAM role ${brand.name} will`} <code>sts:AssumeRole</code>{' '}
          {`into. Configure its trust policy
          to allow this service account with the external id below.`}
        </p>
        {fields.roleArn ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.roleArn}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="aws-conn-ext">External ID</Label>
        <Input
          id="aws-conn-ext"
          type="text"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          placeholder="vulnaware-2026-prod"
          required
        />
        <p className="text-caption text-muted-foreground">
          External id from your trust policy’s <code>Condition</code>.{' '}
          {`${brand.name} stores it alongside
          the ARN; rotate by updating the trust policy and patching this value.`}
        </p>
        {fields.externalId ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.externalId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="aws-conn-regions">Regions (comma-separated)</Label>
        <Input
          id="aws-conn-regions"
          type="text"
          value={regionsInput}
          onChange={(e) => setRegionsInput(e.target.value)}
          placeholder="us-east-1, us-west-2"
        />
        <p className="text-caption text-muted-foreground">
          Leave empty to enumerate the platform default plus us-east-1. Up to 20 regions per
          connection.
        </p>
        {fields.regions ? (
          <p className="text-caption text-destructive" role="alert">
            {fields.regions}
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
          No AWS credentials stored — STS only.
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
