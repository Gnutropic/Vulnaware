// @polsia:user-owned — Server layout that gates every /scans/** path. Anonymous
// visitors are redirected to /login?next=/scans so the post-login bounce
// returns them to the same page they were on. Authenticated visitors reach
// {children} unchanged — the per-page client islands handle their own data
// fetching via @/lib/api-client.

import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSessionUser } from '@/lib/require-auth';

export default async function ScansLayout({ children }: { children: ReactNode }) {
  const session = await getSessionUser();
  if (!session) {
    redirect('/login?next=/scans');
  }
  return <>{children}</>;
}
