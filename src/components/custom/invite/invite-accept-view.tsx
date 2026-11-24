// @polsia:user-owned

'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { brand } from '@/lib/brand';
import {
  type InviteAcceptRequest,
  InviteAcceptResponse,
  InviteStatus,
} from '@/lib/contracts/invites';

// Client island for /invite/[token]. Talks to the data plane via apiFetch,
// so the page can stay a Server Component that only exports metadata. Branches
// on the InviteStatus discriminated union returned by GET /api/invites/[token]
// without re-parsing HTTP statuses, then submits POST /api/invites/[token]/accept
// for both signup and signin paths. On a 200 we hard-navigate to the
// `redirect` returned by the server so the freshly-set session cookie is
// picked up by the destination page.

export function InviteAcceptView({ token }: { token: string }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; status: Extract<InviteStatus, { status: 'pending' }> }
    | { kind: 'invalid' }
    | { kind: 'consumed' }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiFetch(`/api/invites/${encodeURIComponent(token)}`, {
          schema: InviteStatus,
        });
        if (cancelled) return;
        if (status.status === 'pending') {
          setState({ kind: 'ready', status });
        } else {
          setState({ kind: status.status });
        }
      } catch {
        if (!cancelled) setState({ kind: 'invalid' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <Card className="relative w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
        <CardContent className="flex items-center justify-center pt-8 pb-8">
          <p className="text-small text-muted-foreground">Verifying your invitation…</p>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <Card className="relative w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-h4">This invite is no longer valid</CardTitle>
          <CardDescription>
            The link may have expired or been revoked. Ask the person who invited you to send a new
            one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (state.kind === 'consumed') {
    return (
      <Card className="relative w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-h4">Already accepted</CardTitle>
          <CardDescription>
            This invitation was already used. Sign in to your account to open the team workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <Button asChild className="w-full">
            <a href="/login">Go to sign in</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Pending — show the appropriate accept form
  return <AcceptForm token={token} data={state.status} />;
}

function AcceptForm({
  token,
  data,
}: {
  token: string;
  data: Extract<InviteStatus, { status: 'pending' }>;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const body: InviteAcceptRequest = data.existingUser
        ? { password }
        : { password, name: name.trim() || undefined };
      const res = await apiFetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify(body),
        schema: InviteAcceptResponse,
      });
      // The accept route's Set-Cookie headers have already been persisted by
      // the browser via the JSON response — `apiFetch` uses native fetch, so
      // the cookies travel back on the response. A hard-navigate forces the
      // next-page server render to see them.
      window.location.assign(res.redirect);
    } catch (err) {
      const detail = (err as { cause?: { error?: string } })?.cause?.error;
      const message =
        typeof detail === 'string' && detail.length > 0
          ? detail
          : 'Could not accept the invitation. Please try again.';
      setError(message);
      toast.error(message);
      setPending(false);
    }
  }

  return (
    <Card className="relative w-full max-w-md shadow-brand border border-border/60 bg-card/95 backdrop-blur-sm">
      <CardHeader className="text-center pb-2">
        <p className="text-eyebrow text-muted-foreground">{brand.name}</p>
        <CardTitle className="text-h3">You’ve been invited to {data.teamName}</CardTitle>
        <CardDescription>
          {data.existingUser
            ? `Sign in with ${data.email} to join ${data.teamName}.`
            : `Create an account for ${data.email} to join ${data.teamName}.`}
        </CardDescription>
        <div className="mt-3 flex items-center justify-center gap-2">
          <Badge variant={data.existingUser ? 'secondary' : 'outline'}>
            {data.existingUser ? 'Existing account' : 'New account'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
          {!data.existingUser ? (
            <>
              <Label htmlFor="invite-name">Full name</Label>
              <Input
                id="invite-name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                aria-invalid={error ? true : undefined}
              />
            </>
          ) : null}

          <Label htmlFor="invite-email" className="sr-only">
            Email
          </Label>
          <Input
            id="invite-email"
            type="email"
            value={data.email}
            disabled
            readOnly
            aria-label="Email address"
          />

          <Label htmlFor="invite-password">
            {data.existingUser ? 'Your password' : 'Choose a password'}
          </Label>
          <Input
            id="invite-password"
            name="password"
            type="password"
            autoComplete={data.existingUser ? 'current-password' : 'new-password'}
            minLength={8}
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
          />

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending
              ? data.existingUser
                ? 'Joining…'
                : 'Creating account & joining…'
              : data.existingUser
                ? 'Sign in and join'
                : 'Create account and join'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
