// @polsia:user-owned — Assign-by-email island for team admins.

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
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
import { apiFetch } from '@/lib/api-client';
import {
  MembershipAssign,
  type MembershipAssignInput,
  MembershipItem,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
} from '@/lib/contracts/team';
import { applyServerErrors } from '@/lib/forms';
import { TEAM_INVALIDATE_EVENT } from './roster-table';

interface Props {
  onAssigned?: () => void;
}

export function TeamAssignForm({ onAssigned }: Props) {
  const form = useForm<MembershipAssignInput>({
    resolver: zodResolver(MembershipAssign),
    defaultValues: { email: '', role: 'member' },
  });
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await apiFetch('/api/team/memberships', {
        method: 'POST',
        body: JSON.stringify(values),
        schema: MembershipItem,
      });
      toast.success(`${values.email} added as ${ROLE_LABELS[values.role]}.`);
      form.reset({ email: '', role: 'member' });
      window.dispatchEvent(new Event(TEAM_INVALIDATE_EVENT));
      onAssigned?.();
    } catch (err) {
      const applied = err instanceof Error && applyServerErrors(err.cause, form.setError);
      if (!applied) {
        const msg = err instanceof Error ? err.message : 'Could not add member.';
        if (msg.includes('404')) {
          form.setError('email', {
            type: 'server',
            message: 'No account exists for that email.',
          });
        } else if (msg.includes('409')) {
          form.setError('email', {
            type: 'server',
            message: 'That user is already on a workspace.',
          });
        } else {
          toast.error(msg);
        }
      }
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Form {...form}>
      <form
        onSubmit={onSubmit}
        className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-md"
        noValidate
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="off"
                  placeholder="teammate@example.com"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Role</FormLabel>
              <Select value={field.value} onValueChange={(value) => field.onChange(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>
                  <SelectItem value="member">{ROLE_LABELS.member}</SelectItem>
                  <SelectItem value="viewer">{ROLE_LABELS.viewer}</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-caption text-muted-foreground">
                {ROLE_DESCRIPTIONS[field.value]}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Adding…
              </>
            ) : (
              <>
                <UserPlus className="size-4" aria-hidden /> Add to team
              </>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
