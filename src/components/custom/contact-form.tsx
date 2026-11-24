// @polsia:user-owned — public /contact form island. RHF + zodResolver +
// shadcn Form primitives so the form composes the same primitives the rest of
// the app uses. POST /api/contact is the only data transport; server validation
// errors surface via applyServerErrors (Shape A flat-map from the route).

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import { type ContactInput, contactResponseSchema, contactSchema } from '@/lib/contact/schema';
import { applyServerErrors } from '@/lib/forms';

export function ContactForm() {
  const form = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: '',
      email: '',
      company: '',
      message: '',
      website: '',
    },
  });
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await apiFetch('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          company: values.company,
          message: values.message,
          // Honeypot is included so bots that inspect the JSON payload still
          // see the field — but real users never fill it because it's
          // visually hidden and excluded from the tab order.
          website: values.website ?? '',
        }),
        schema: contactResponseSchema,
      });
      setSent(true);
    } catch (err) {
      if (err instanceof Error && applyServerErrors(err.cause, form.setError)) {
        return;
      }
      // Non-blocking — values are already preserved (RHF keeps form state
      // even on submit errors), so the operator just retries.
      const message = err instanceof Error ? err.message : 'We couldn’t send your message.';
      toast.error('We couldn’t send your message. Please try again in a minute.');
      form.setError('message', { type: 'server', message });
    } finally {
      setSubmitting(false);
    }
  });

  if (sent) {
    return (
      <Card className="border-border/80 bg-card/80 shadow-md">
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-brand-500/15 text-brand-500"
          >
            <CheckCircle2 className="size-7" />
          </span>
          <h3 className="font-display text-h3 tracking-tight text-foreground">
            Thanks — message received.
          </h3>
          <p className="max-w-sm text-body text-muted-foreground">
            A real human at VulnAware will come back within one business day. If it&apos;s urgent,
            the direct line in the page copy above routes straight to the same inbox.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={onSubmit}
        className="grid gap-5 rounded-[var(--radius-xl)] border border-border bg-card p-6 shadow-lg sm:p-8"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="name" placeholder="Jordan Reyes" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Work email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="jordan@example.com"
                  autoComplete="email"
                  {...field}
                />
              </FormControl>
              <FormDescription>We use this to reply — not for any drip campaign.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="company"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Company <span className="font-normal text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input
                  autoComplete="organization"
                  placeholder="Acme Inc."
                  {...field}
                  value={field.value ?? ''}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="message"
          render={({ field }) => (
            <FormItem>
              <FormLabel>How can we help?</FormLabel>
              <FormControl>
                <Textarea
                  rows={7}
                  placeholder="Tell us about your stack, the regulatory posture you’re operating under, or what you’d like a demo to focus on."
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Honeypot — visually hidden, off the tab order, semantically absent
            for assistive tech. A real visitor never fills this; a bot does. */}
        <div aria-hidden="true" className="hidden">
          <FormField
            control={form.control}
            name="website"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Website</FormLabel>
                <FormControl>
                  <Input
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-small text-muted-foreground">
            By submitting, you agree to a single reply from the VulnAware team.
          </p>
          <Button type="submit" disabled={submitting} className="shadow-brand">
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Sending…
              </>
            ) : (
              <>
                <Send className="size-4" aria-hidden /> Send message
              </>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
