// @polsia:user-owned

import Link from 'next/link';
import { Suspense } from 'react';
import { PasswordResetForm } from '@/components/custom/password-reset-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { brand } from '@/lib/brand';

export const metadata = {
  title: `Choose a new ${brand.name} password`,
  description: `Set a new password for your ${brand.name} account.`,
};

export default function ResetPasswordPage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--background)] px-gutter py-section">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute left-1/2 top-[-30%] h-[800px] w-[800px] -translate-x-1/2 rounded-full bg-[var(--brand-100)] opacity-40 blur-3xl" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[500px] w-[500px] rounded-full bg-[var(--brand-200)] opacity-30 blur-3xl" />
      </div>

      <Card className="relative w-full max-w-md border border-border/60 bg-card/95 shadow-brand backdrop-blur-sm">
        <CardHeader className="pb-2 text-center">
          <CardTitle className="text-h4">Reset your password</CardTitle>
          <CardDescription>Choose a new password for your {brand.name} account.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <Suspense
            fallback={
              <p className="text-center text-sm text-muted-foreground">Loading reset link…</p>
            }
          >
            <PasswordResetForm />
          </Suspense>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            <Link
              href="/login"
              className="font-medium text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline"
            >
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
