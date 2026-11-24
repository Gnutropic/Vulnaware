// @polsia:user-owned — Tier-aware public trial signup form island.
//
// Rendered on `/signup?tier={starter|pro|enterprise}` by the Server
// Component. The visitor supplies their own password, the workspace
// name, and the form POSTs to /api/trial/tiered-signup which
// provisions Workspace + Team + admin WorkspaceMember atomically,
// forwards better-auth's Set-Cookie so the browser is authenticated
// on the redirect, and returns a server-picked redirectUrl.
//
// `tier` is rendered as a read-only Badge with the workspace-name +
// email fields under it; the user can correct the wrong tier by
// navigating back to `/pricing`. Holds the same Honeypot posture as
// `TrialCta` — visually + AT hidden `confirmEmail`.

'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import {
  type TieredTrialSignupBodyInput,
  type TieredTrialSignupTier,
  TrialCreateResponse,
} from '@/lib/contracts/trial';

export function TierSignupForm({ tier }: { tier: TieredTrialSignupTier }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Pure-local strength bar — no fetch, just min(12-char / password length).
  // Same posture as the password hint copy: drives the visual without
  // touching the network.
  const strength = Math.min((password.length / 12) * 100, 100);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!email.trim() || !password || !workspaceName.trim()) {
      setError('Email, password, and workspace name are required.');
      return;
    }
    setSubmitting(true);
    try {
      const body: TieredTrialSignupBodyInput = {
        email: email.trim().toLowerCase(),
        password,
        workspaceName: workspaceName.trim(),
        tier,
        confirmEmail: honeypot,
      };
      const result = await apiFetch('/api/trial/tiered-signup', {
        method: 'POST',
        body: JSON.stringify(body),
        schema: TrialCreateResponse,
      });
      router.push(result.redirectUrl);
    } catch (err: unknown) {
      // Reach this branch only on unexpected server failure. The route
      // returns 200 with the OK shape for every expected failure (incl.
      // honeypot, schema mismatch from the contract) so an error here
      // is a true infrastructure problem.
      const cause = (err as { cause?: { errors?: Record<string, string> } })?.cause;
      if (cause?.errors && Object.keys(cause.errors).length > 0) {
        setFieldErrors(cause.errors);
        setError('Please correct the highlighted fields.');
      } else {
        setError('Could not start your trial right now. Try again or email us.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid w-full max-w-xl gap-4"
      noValidate
      aria-labelledby="tier-signup-heading"
    >
      <div className="flex items-center gap-2 text-eyebrow text-brand-500">
        <Sparkles className="size-3.5" aria-hidden />
        <span>14-day trial · no credit card · sample data preloaded</span>
      </div>

      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className="border border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          {tier.toUpperCase()} tier · 14-day trial
        </Badge>
        <span className="text-caption text-muted-foreground">
          {brand.name} {tier === 'enterprise' ? 'Enterprise' : tier === 'pro' ? 'Team' : 'Starter'}{' '}
          Plan
        </span>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="tier-workspace-name">Workspace name</Label>
        <Input
          id="tier-workspace-name"
          name="workspaceName"
          type="text"
          placeholder="acme-prod"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          required
          aria-invalid={fieldErrors.workspaceName ? true : undefined}
          maxLength={80}
        />
        {fieldErrors.workspaceName ? (
          <p className="text-caption text-destructive" role="alert">
            {fieldErrors.workspaceName}
          </p>
        ) : (
          <p className="text-caption text-muted-foreground">
            A short identifier for this trial. We&apos;ll add a randomized suffix so your workspace
            stays unique.
          </p>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="tier-email">Admin email</Label>
        <Input
          id="tier-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          aria-invalid={fieldErrors.email ? true : undefined}
          maxLength={254}
        />
        {fieldErrors.email ? (
          <p className="text-caption text-destructive" role="alert">
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="tier-password">Password</Label>
        <Input
          id="tier-password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-invalid={fieldErrors.password ? true : undefined}
          minLength={8}
          maxLength={128}
        />
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Password strength"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(strength)}
        >
          <div
            className="h-full bg-brand-500 transition-[width] duration-300"
            style={{ width: `${strength}%` }}
          />
        </div>
        {fieldErrors.password ? (
          <p className="text-caption text-destructive" role="alert">
            {fieldErrors.password}
          </p>
        ) : (
          <p className="text-caption text-muted-foreground">
            Use at least 8 characters. You&apos;ll sign in with this password next time.
          </p>
        )}
      </div>

      {/* Honeypot — visually + AT hidden; the route rejects a non-empty value. */}
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
        <Label htmlFor="tier-confirm-email">Confirm email</Label>
        <input
          id="tier-confirm-email"
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
        You&apos;ll be signed in immediately after submit. Sample scan data is preloaded so the
        dashboard renders populated the moment you arrive.
      </p>
    </form>
  );
}
