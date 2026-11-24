// @polsia:user-owned — trial-funnel step 4 beacon (dashboard_viewed).
//
// Client island. Reads the user's id from better-auth's useSession()
// (already used by the dashboard page). If today's per-user marker
// is missing, fires one POST to /api/analytics/events. The marker is
// scoped `<userId>:<YYYY-MM-DD>` so the same visitor accounts for
// exactly one row per calendar day regardless of how many times they
// reload the dashboard. Renders nothing.
//
// A signed-out visitor never reaches this island (the dashboard
// layout already redirects to /login), but if the island somehow
// mounts before the session resolves it short-circuits — the user's
// actual id (and therefore the server-side teamId) is required for
// the row to be useful.

'use client';

import { useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { TrialFunnelEventIngestResponse } from '@/lib/contracts/analytics';

const DEDUPE_KEY = 'polsia_dashboard_viewed';

function todayKey(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function DashboardViewTracker(): null {
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (isPending) return;
    if (!userId) return;

    const marker = `${userId}:${todayKey(new Date())}`;
    try {
      if (window.localStorage.getItem(DEDUPE_KEY) === marker) return;
    } catch {
      // localStorage locked — fall through and try the write anyway;
      // worst case is one extra row per session, not a UX issue.
    }

    try {
      window.localStorage.setItem(DEDUPE_KEY, marker);
    } catch {
      // Best-effort — continue with the write.
    }

    void apiFetch('/api/analytics/events', {
      method: 'POST',
      body: JSON.stringify({ step: 'dashboard_viewed' }),
      schema: TrialFunnelEventIngestResponse,
    }).catch(() => undefined);
  }, [isPending, userId]);

  return null;
}
