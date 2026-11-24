// @polsia:user-owned
'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

const emailSchema = z.string().trim().email();
const confirmation = 'If an account exists for this email, we’ll send a password reset link';

export function PasswordResetRequestForm() {
  const emailInput = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => setReady(true), []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedEmail = emailSchema.safeParse(emailInput.current?.value ?? '');
    if (!parsedEmail.success) {
      setError('Enter a valid email address.');
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      const { error: requestError } = await authClient.requestPasswordReset({
        email: parsedEmail.data,
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (requestError) {
        setError('We couldn’t submit your request. Please try again.');
        return;
      }

      setSubmitted(true);
    } catch {
      setError('We couldn’t submit your request. Please try again.');
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <div className="space-y-4 text-center">
        <output className="block text-sm leading-6 text-foreground" aria-live="polite">
          {confirmation}
        </output>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate aria-busy={pending}>
      <Label htmlFor="password-reset-email">Email address</Label>
      <Input
        ref={emailInput}
        id="password-reset-email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        defaultValue=""
        required
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={!ready || pending} className="mt-2 w-full">
        {!ready ? 'Loading…' : pending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
