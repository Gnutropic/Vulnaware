// @polsia:user-owned — Scheduled cloud discovery runs panel. Admin-only island
// mounted inside the team settings page. Lists / creates / deletes per-team
// CloudDiscoverySchedule rows through /api/v1/cloud/discovery/schedule +
// /api/v1/cloud/discovery/schedule/[id]. The cron itself runs as
// infrastructure (no session) and reads the same table directly.
//
// Mirrors assign-form.tsx + roster-table.tsx posture: useIsAdmin() gate, the
// same applyServerErrors + toast pattern on failure. The whole island
// ('create form' + 'list') is hidden for non-admins — only the caption
// describe-the-feature renders.

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Clock, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import { useIsAdmin } from '@/lib/auth-client';
import {
  type CloudDiscoveryProvider,
  CloudDiscoveryScheduleCreate,
  type CloudDiscoveryScheduleCreateInput,
  CloudDiscoveryScheduleItem,
  CloudDiscoveryScheduleList,
  MIN_CADENCE_MINUTES,
} from '@/lib/contracts/cloud-discovery';
import { applyServerErrors } from '@/lib/forms';

const PROVIDER_LABELS: Record<CloudDiscoveryProvider, string> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
};

function formatCadence(cadenceMinutes: number): string {
  if (cadenceMinutes < 60) {
    return `every ${cadenceMinutes}m`;
  }
  if (cadenceMinutes % (60 * 24) === 0) {
    const days = cadenceMinutes / (60 * 24);
    return `every ${days}d`;
  }
  if (cadenceMinutes % 60 === 0) {
    const hours = cadenceMinutes / 60;
    return `every ${hours}h`;
  }
  return `every ${cadenceMinutes}m`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

interface ScheduleRow extends CloudDiscoveryScheduleItem {
  id: string;
}

export function DiscoverySchedulePanel() {
  const isAdmin = useIsAdmin();

  const [items, setItems] = useState<ScheduleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const form = useForm<CloudDiscoveryScheduleCreateInput>({
    resolver: zodResolver(CloudDiscoveryScheduleCreate),
    defaultValues: { provider: 'aws', cadenceMinutes: MIN_CADENCE_MINUTES },
  });
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/v1/cloud/discovery/schedule', {
        schema: CloudDiscoveryScheduleList,
      });
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedules');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await apiFetch('/api/v1/cloud/discovery/schedule', {
        method: 'POST',
        body: JSON.stringify(values),
        schema: CloudDiscoveryScheduleItem,
      });
      toast.success(
        `Scheduled ${PROVIDER_LABELS[values.provider]} every ${values.cadenceMinutes}m.`,
      );
      await reload();
    } catch (err) {
      const cause =
        err instanceof Error && 'cause' in err
          ? (err as Error & { cause: unknown }).cause
          : undefined;
      const applied = applyServerErrors(cause as unknown, form.setError);
      if (!applied) {
        const msg = err instanceof Error ? err.message : 'Could not create schedule.';
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  });

  const onRemove = useCallback(
    async (row: ScheduleRow) => {
      setDeletingId(row.id);
      try {
        await apiFetch(`/api/v1/cloud/discovery/schedule/${row.id}`, { method: 'DELETE' });
        toast.success(`Removed ${PROVIDER_LABELS[row.provider]} schedule.`);
        await reload();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not remove schedule.';
        toast.error(msg);
        await reload();
      } finally {
        setDeletingId(null);
      }
    },
    [reload],
  );

  return (
    <div className="grid gap-4">
      <p className="max-w-prose text-caption text-muted-foreground">
        Each minute the cron picks every scheduled row whose <code>nextRunAt</code> has passed and
        runs discovery against the team&rsquo;s connections for that provider. Cadence floor is{' '}
        {MIN_CADENCE_MINUTES} minutes.
      </p>

      {isAdmin ? (
        <>
          <Form {...form}>
            <form
              onSubmit={onSubmit}
              className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md sm:grid-cols-[1fr_1fr_auto] sm:items-end"
              noValidate
            >
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cloud provider</FormLabel>
                    <Select value={field.value} onValueChange={(value) => field.onChange(value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="aws">{PROVIDER_LABELS.aws}</SelectItem>
                        <SelectItem value="azure">{PROVIDER_LABELS.azure}</SelectItem>
                        <SelectItem value="gcp">{PROVIDER_LABELS.gcp}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cadenceMinutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cadence (minutes)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={MIN_CADENCE_MINUTES}
                        step={60}
                        value={field.value ?? ''}
                        onChange={(event) => {
                          const next = event.target.value;
                          field.onChange(next === '' ? undefined : Number(next));
                        }}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <p className="mt-1 text-caption text-muted-foreground">
                      Minimum {MIN_CADENCE_MINUTES}. E.g. 360 for every 6h.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Creating…
                  </>
                ) : (
                  <>Add schedule</>
                )}
              </Button>
            </form>
          </Form>

          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-md">
            {items === null ? (
              <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading schedules…
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Cadence</TableHead>
                    <TableHead className="hidden sm:table-cell">Last run</TableHead>
                    <TableHead className="hidden sm:table-cell">Next run</TableHead>
                    <TableHead className="w-[6rem] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {error ? (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <p className="text-caption text-destructive" role="alert">
                          {error}
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                          <Clock className="size-4" aria-hidden />
                          No scheduled runs yet — add one above.
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <Badge variant="secondary">{PROVIDER_LABELS[row.provider]}</Badge>
                        </TableCell>
                        <TableCell className="text-body">
                          {formatCadence(row.cadenceMinutes)}
                        </TableCell>
                        <TableCell className="hidden font-mono text-caption text-muted-foreground sm:table-cell">
                          {formatTimestamp(row.lastRunAt)}
                        </TableCell>
                        <TableCell className="hidden font-mono text-caption text-muted-foreground sm:table-cell">
                          {formatTimestamp(row.nextRunAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={deletingId === row.id}
                            onClick={() => onRemove(row)}
                          >
                            {deletingId === row.id ? (
                              <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : (
                              <Trash2 className="size-4" aria-hidden />
                            )}
                            <span className="sr-only">Remove schedule</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
