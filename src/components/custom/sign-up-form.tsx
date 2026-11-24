// @polsia:user-owned
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signUp } from '@/lib/auth-client';

// Email + password sign-up with confirm-password. Composes the template's base
// shadcn primitives (Button/Input/Label) styled through the theme tokens.
// Restyle freely — this file is user-owned. Calls better-auth's
// authClient.signUp.email; better-auth requires a name field, so we derive it
// from the email's local part. On success the session cookie is set by the
// catch-all route handler and we redirect to /dashboard, which the
// DashboardShell composes inside the dashboard route group. The post-signup
// ensureWorkspaceForUser hook (auth-config) seeds a Team + admin Membership
// so the dashboard's auth gate (DashboardShell) passes.
export function SignUpForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirmPassword !== password) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    setError(undefined);
    const name = email.split('@')[0] || 'user';
    const { error: signUpError } = await signUp.email({ name, email, password });
    setPending(false);
    if (signUpError) {
      setError(signUpError.message ?? 'Could not create your account. Try again.');
      return;
    }
    window.location.assign('/dashboard');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <Label htmlFor="sign-up-email">Email address</Label>
      <Input
        id="sign-up-email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
      />
      <Label htmlFor="sign-up-password">Password</Label>
      <Input
        id="sign-up-password"
        name="password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
      />
      <Label htmlFor="sign-up-confirm-password">Confirm password</Label>
      <Input
        id="sign-up-confirm-password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
