// @polsia:user-owned — Public "Start free trial" form island.
//
// Self-serve conversion surface. The submit handler POSTs to
// /api/v1/trial-signup and routes to the server-supplied redirectUrl on
// success. Honeypot field `confirmEmail` is visually hidden via
// `aria-hidden` + offscreen position; a real user never fills it but
// naive bots do — the server treats any non-empty value as a no-op
// success and dispatches nothing.
//
// The `tier` prop is optional — when set (passed by `/signup?tier=…`),
// the form posts to /api/trial/signup (which signs the visitor in and
// redirects to /dashboard). Otherwise it posts to
// /api/v1/trial-signup (welcome-email claim path) for the home-page
// hero CTA.

'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-client';
import {
  type CompanySize,
  TrialCreateResponse,
  type TrialSignupBodyInput,
} from '@/lib/contracts/trial';

// Company-size options — values mirror the zod enum (the shared
// contract). Labels read as plain prose so a future copy edit doesn't
// need a separate human-readable mapping.
const COMPANY_SIZE_OPTIONS: ReadonlyArray<{ value: CompanySize; label: string }> = [
  { value: '1-10', label: '1–10 employees' },
  { value: '11-50', label: '11–50 employees' },
  { value: '51-200', label: '51–200 employees' },
  { value: '201-1000', label: '201–1,000 employees' },
  { value: '1000+', label: '1,000+ employees' },
];

export function TrialCta({ tier }: { tier?: string | null } = {}) {
  const router = useRouter();
  // `tier` is passed by the server page — e.g. /pricing has no tier
  // context and posts to the welcome-email claim endpoint, while
  // /signup?tier=pro&trial=1 passes "pro" and the form posts to the
  // authenticated /api/trial/signup which signs the visitor in and
  // redirects to /dashboard.
  const tierHint = tier ?? null;
  const endpoint = tierHint ? '/api/trial/signup' : '/api/v1/trial-signup';

  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [companySize, setCompanySize] = useState<CompanySize | ''>('');
  const [honeypot, setHoneypot] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !company.trim()) {
      setError('Email and company are required.');
      return;
    }
    setSubmitting(true);
    try {
      const body: TrialSignupBodyInput = {
        email: email.trim().toLowerCase(),
        company: company.trim(),
        workspaceName: workspaceName.trim() || undefined,
        companySize: companySize || undefined,
        confirmEmail: honeypot,
      };
      const result = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
        schema: TrialCreateResponse,
      });
      toast.success('Your trial workspace is ready.');
      router.push(result.redirectUrl);
    } catch (err) {
      // The route handler replies 200 with the success shape on every
      // expected failure mode (incl. honeypot), so we only land here on
      // an unexpected server error. Surface a generic message and let
      // the user retry.
      setError(
        err instanceof Error && err.message
          ? 'Could not start your trial right now. Try again or email us.'
          : 'Could not start your trial right now. Try again or email us.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      id="trial"
      onSubmit={handleSubmit}
      className="grid w-full max-w-xl gap-4 rounded-[var(--radius-xl)] border border-border bg-card/95 p-6 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/70"
      noValidate
    >
      <div className="flex items-center gap-2 text-eyebrow text-brand-500">
        <Sparkles className="size-3.5" aria-hidden />
        <span>
          14-day trial · no credit card · sample data preloaded
          {tierHint ? ` · ${tierHint.toUpperCase()} tier` : ''}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="trial-email">Work email</Label>
          <Input
            id="trial-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
            maxLength={254}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="trial-company">Company</Label>
          <Input
            id="trial-company"
            name="company"
            type="text"
            autoComplete="organization"
            placeholder="Acme Corp."
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
            maxLength={120}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="trial-workspace-name">Workspace name (optional)</Label>
          <Input
            id="trial-workspace-name"
            name="workspaceName"
            type="text"
            placeholder="acme-prod"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            aria-invalid={error ? true : undefined}
            maxLength={80}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="trial-company-size">Company size</Label>
          <Select value={companySize} onValueChange={(v) => setCompanySize(v as CompanySize | '')}>
            <SelectTrigger
              id="trial-company-size"
              aria-label="Company size"
              aria-invalid={error ? true : undefined}
            >
              <SelectValue placeholder="Select team size" />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_SIZE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-caption text-muted-foreground">
        A short identifier for this trial. We&apos;ll add a randomized suffix so your workspace
        stays unique.
      </p>

      {/* Honeypot — visually + AT hidden. Real users never fill it. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 'auto',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
        }}
      >
        <Label htmlFor="trial-confirm-email">Confirm email</Label>
        <input
          id="trial-confirm-email"
          name="confirmEmail"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          maxLength={0}
        />
      </div>

      {error ? (
        <p className="text-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={submitting} className="w-full sm:w-auto" size="lg">
        {submitting ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden /> Provisioning…
          </>
        ) : (
          <>
            <Sparkles className="size-4" aria-hidden /> Start free trial
          </>
        )}
      </Button>

      <p className="text-caption text-muted-foreground">
        We&apos;ll email you a one-time link to claim your workspace. Sample scan data is preloaded
        so the dashboard renders populated the moment you sign in.
      </p>
    </form>
  );
}
