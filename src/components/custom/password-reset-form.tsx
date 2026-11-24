// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

const invalidLinkMessage =
  'This reset link is invalid or has expired. Request a new link to continue.';

export function PasswordResetForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => setReady(true), []);

  if (searchParams.has('error') || !token) {
    return <ResetMessage message={invalidLinkMessage} />;
  }
  const validToken = token;

  if (complete) {
    return (
      <div className="space-y-4 text-center">
        <output className="block text-sm leading-6 text-foreground" aria-live="polite">
          Your password has been reset.
        </output>
        <Button asChild className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      const { error: resetError } = await authClient.resetPassword({
        newPassword: password,
        token: validToken,
      });
      if (resetError) {
        setError(invalidLinkMessage);
        return;
      }
      setComplete(true);
    } catch {
      setError(invalidLinkMessage);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate aria-busy={pending}>
      <Label htmlFor="password-reset-new">New password</Label>
      <Input
        id="password-reset-new"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        minLength={8}
        aria-invalid={error ? true : undefined}
      />
      <Label htmlFor="password-reset-confirm">Confirm new password</Label>
      <Input
        id="password-reset-confirm"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        required
        minLength={8}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={!ready || pending} className="mt-2 w-full">
        {!ready ? 'Loading…' : pending ? 'Updating password…' : 'Update password'}
      </Button>
    </form>
  );
}

function ResetMessage({ message }: { message: string }) {
  return (
    <div className="space-y-4 text-center">
      <output className="block text-sm leading-6 text-foreground" aria-live="polite">
        {message}
      </output>
      <Button asChild className="w-full">
        <Link href="/forgot-password">Request a new reset link</Link>
      </Button>
    </div>
  );
}
