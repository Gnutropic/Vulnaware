// @polsia:user-owned — "Contact sales" modal island mounted on the /pricing
// Enterprise card. Self-contained: owns dialog open state, RHF instance, the
// success view, and dismissal. Reuses the shared contactSchema contract so
// client-side validation mirrors the route. POSTs to /api/contact via apiFetch.

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Loader2, Mail, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import { contactResponseSchema } from '@/lib/contact/schema';
import { applyServerErrors } from '@/lib/forms';

// Modal-specific fields. Mirrors the route's shared `contactSchema` for the
// overlapping fields (`email`, `message`, `website`) and adds `company` as a
// required text field. `teamSize` rides through cleanly — the parent schema's
// optional string union means the Select value lands in `parsed.data.teamSize`
// server-side without a per-option enum.
const enterpriseContactSalesSchema = z.object({
  company: z
    .string()
    .min(1, 'Please enter your company name.')
    .max(120, 'Company name is too long.'),
  email: z.string().email('Please enter a valid work email.').max(254, 'Email is too long.'),
  teamSize: z.string().min(1, 'Please pick a team size.').max(40, 'Team size is too long.'),
  message: z
    .string()
    .min(1, 'Please tell us a bit about what you need.')
    .max(5000, 'Message is too long (5000 characters max).'),
  website: z.string().max(120).optional(),
});

type EnterpriseContactInput = z.infer<typeof enterpriseContactSalesSchema>;

const TEAM_SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: '1-10', label: '1–10' },
  { value: '11-50', label: '11–50' },
  { value: '51-200', label: '51–200' },
  { value: '201-1000', label: '201–1,000' },
  { value: '1000+', label: '1,000+' },
];

type TriggerProps = Omit<React.ComponentProps<typeof Button>, 'asChild'>;

export function EnterpriseContactSalesButton({ children, ...triggerProps }: TriggerProps) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const companyFieldRef = useRef<HTMLInputElement | null>(null);

  const form = useForm<EnterpriseContactInput>({
    resolver: zodResolver(enterpriseContactSalesSchema),
    defaultValues: {
      company: '',
      email: '',
      teamSize: '',
      message: '',
      website: '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await apiFetch('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          // The route's `name` field is the personal-name slot; sales
          // inquiries from this modal are company-scoped, so we lift the
          // company value into `name`. The email template's `Company:`
          // line reads `company` and then falls back to `—`.
          name: values.company,
          email: values.email,
          company: values.company,
          message: `[Team size] ${values.teamSize}\n\n${values.message}\n\n— Company: ${values.company}`,
          teamSize: values.teamSize,
          website: values.website ?? '',
        }),
        schema: contactResponseSchema,
      });
      setSent(true);
    } catch (err) {
      if (err instanceof Error && applyServerErrors(err.cause, form.setError)) {
        return;
      }
      const message = err instanceof Error ? err.message : 'We couldn’t send your message.';
      toast.error('We couldn’t send your message. Please try again in a minute.');
      form.setError('message', { type: 'server', message });
    } finally {
      setSubmitting(false);
    }
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSent(false);
      form.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button {...triggerProps} type="button">
          {children ?? (
            <>
              <Mail className="size-4" aria-hidden /> Contact sales
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        // Radix defaults focus to the X close button on open. Override so
        // the first form field gets focus — keyboard users land directly
        // in the company input rather than tabbing past the close.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          companyFieldRef.current?.focus();
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      >
        {sent ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <span
              aria-hidden
              className="flex size-12 items-center justify-center rounded-full bg-brand-500/15 text-brand-500"
            >
              <CheckCircle2 className="size-7" />
            </span>
            <DialogHeader className="items-center text-center">
              <DialogTitle className="font-display text-h3 tracking-tight text-foreground">
                Thanks — we&apos;ll be in touch.
              </DialogTitle>
              <DialogDescription className="max-w-sm text-body text-muted-foreground">
                A real person from our team will get back to you within 1 business day. If it&apos;s
                urgent, the direct line in the page copy above routes to the same inbox.
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="mt-2"
            >
              Close
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-h3 tracking-tight text-foreground">
                Contact our Enterprise team
              </DialogTitle>
              <DialogDescription className="text-body text-muted-foreground">
                Tell us a bit about your team and what you need — we&apos;ll come back with pricing
                and a recommended rollout within 1 business day.
              </DialogDescription>
            </DialogHeader>

            <Form {...form}>
              <form onSubmit={onSubmit} className="grid gap-5" noValidate>
                <FormField
                  control={form.control}
                  name="company"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company name</FormLabel>
                      <FormControl>
                        <Input
                          autoComplete="organization"
                          placeholder="Acme Inc."
                          {...field}
                          ref={(el) => {
                            field.ref(el);
                            companyFieldRef.current = el;
                          }}
                        />
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
                          autoComplete="email"
                          placeholder="jordan@acme.com"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        We use this to reply — never for drip campaigns.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="teamSize"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Team size</FormLabel>
                      <Select
                        value={field.value || undefined}
                        onValueChange={(value) => field.onChange(value)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a range" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {TEAM_SIZE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>What can we help with?</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={5}
                          placeholder="Stack, regulatory posture, or what you’d like a demo to focus on."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Honeypot — visually hidden, off the tab order, semantically
                    absent for assistive tech. Real visitors never fill this;
                    bots do, and the route silently ack’s with no side effects. */}
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
                    By submitting, you agree to a single reply from our team.
                  </p>
                  <Button type="submit" disabled={submitting} className="shadow-brand">
                    {submitting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden /> Sending…
                      </>
                    ) : (
                      <>
                        <Send className="size-4" aria-hidden /> Send inquiry
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
