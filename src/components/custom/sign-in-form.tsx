// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn } from '@/lib/auth-client';

// Email + password sign-in. Composes the template's base shadcn primitives
// (Button/Input/Label) styled through the theme tokens. Restyle freely — this
// file is user-owned. Calls better-auth's authClient.signIn.email; on success
// the session cookie is set by the catch-all route handler and the page
// redirects to the `next` query param (defaults to '/dashboard').
export function SignInForm() {
  const searchParams = useSearchParams();
  const nextRaw = searchParams.get('next');
  // Only allow same-origin/pure path so an attacker can't redirect to a
  // phishing page via ?next=https://evil.example. Accept either "/" + path
  // segments only, or a full URL with the same host we're already on.
  const next = sanitizeNext(nextRaw);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    const { error: signInError } = await signIn.email({ email, password });
    setPending(false);
    if (signInError) {
      setError(signInError.message ?? 'Could not sign in. Check your details.');
      return;
    }
    window.location.assign(next ?? '/dashboard');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <Label htmlFor="sign-in-email">Email address</Label>
      <Input
        id="sign-in-email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
      />
      <Label htmlFor="sign-in-password">Password</Label>
      <Input
        id="sign-in-password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
      />
      <div className="-mt-1 flex justify-end">
        <Link
          href="/forgot-password"
          className="text-sm font-medium text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline"
        >
          Forgot password?
        </Link>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

// Same-origin path-only redirect target. Falls back to "/" when unsafe.
// Used to honor `?next=` round-trips without opening an open-redirect hole.
function sanitizeNext(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  return value;
}
