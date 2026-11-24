// @polsia:user-owned — Invite-by-email island for team admins. Mints a
// pending WorkspaceMember row via POST /api/team/invite and emails the
// recipient a magic link to /invite/[token]. Dispatches a 'team:invalidate'
// event on success so the sibling roster refetches without a server-
// component rebuild.

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-client';
import { useIsAdmin } from '@/lib/auth-client';
import {
  WorkspaceMemberInviteCreate,
  type WorkspaceMemberInviteCreateInput,
  WorkspaceMemberInviteItem,
} from '@/lib/contracts/workspace-member';
import { applyServerErrors } from '@/lib/forms';
import { TEAM_INVALIDATE_EVENT } from './roster-table';

const DEFAULT_TTL_HOURS = 72;

export function TeamInviteForm() {
  const isAdmin = useIsAdmin();
  const defaultTtl = DEFAULT_TTL_HOURS * 60 * 60;
  const form = useForm<WorkspaceMemberInviteCreateInput>({
    resolver: zodResolver(WorkspaceMemberInviteCreate),
    defaultValues: { email: '', ttlSeconds: defaultTtl },
  });
  const [submitting, setSubmitting] = useState(false);

  if (!isAdmin) {
    return (
      <p className="text-caption text-muted-foreground">
        Only workspace admins can invite by email.
      </p>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await apiFetch('/api/team/invite', {
        method: 'POST',
        body: JSON.stringify(values),
        schema: WorkspaceMemberInviteItem,
      });
      toast.success(`Invitation sent to ${values.email}.`);
      form.reset({ email: '', ttlSeconds: defaultTtl });
      window.dispatchEvent(new Event(TEAM_INVALIDATE_EVENT));
    } catch (err) {
      const applied = err instanceof Error && applyServerErrors(err.cause, form.setError);
      if (!applied) {
        const msg = err instanceof Error ? err.message : 'Could not send invitation.';
        if (msg.includes('409')) {
          form.setError('email', {
            type: 'server',
            message: 'That person is already a member of this workspace.',
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
              <FormDescription>
                The recipient does not need to already have an account — they&rsquo;ll be prompted
                to sign up (or sign in) when they accept the link.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="ttlSeconds"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Link expires in (hours)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  max={720}
                  step={1}
                  value={Math.round((field.value ?? defaultTtl) / 3600)}
                  onChange={(event) => {
                    const hours = Number(event.target.value);
                    if (Number.isFinite(hours) && hours > 0) {
                      field.onChange(hours * 3600);
                    }
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Sending…
              </>
            ) : (
              <>
                <Send className="size-4" aria-hidden /> Send invitation
              </>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
