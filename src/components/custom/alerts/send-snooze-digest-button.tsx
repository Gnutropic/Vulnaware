// @polsia:user-owned — `Send snooze digest` toolbar button for the /alerts
// page. Mirrors AlertsExportButton's posture (an on-demand gesture
// adjacent to the export CTA) but with a different shape:
//   - The button drives a POST request (not a navigation). The
//     `apiFetch('/api/alerts/snooze-digest', { method: 'POST', body: '{}' })`
//     happens against the same-origin /api route so the response stays
//     in-process; no window.location round-trip.
//   - The button is GATED by `useSession()` — anonymous visitors on
//     /alerts land on the same sign-in CTA but the toolbar hides the
//     digest surface. The hook reads the same session the
//     DashboardShell parent provides so the initial-render flash on a
//     freshly-mounted tab stays empty (the button isn't visible until
//     the session resolves).
//   - The button owns a local `pending` flag. While concurrent fetches
//     gate the onClick handler so a stale double-click can't queue a
//     second fan-out. Toast on success/failure surfaces the result;
//     the toast copy mirrors the routes's `sent` + `reason` shape, so
//     the operator gets a clear "X alerts, no email — try again later"
//     signal on `reason === 'no_snoozed'` or 'no_email'.

'use client';

import { Loader2, Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';

interface SendResponse {
  sent: boolean;
  totalAlerts: number;
  reason?: 'no_email' | 'no_snoozed' | 'send_failed';
}

export function SendSnoozeDigestButton() {
  const { data: session } = useSession();
  const [pending, setPending] = useState(false);

  // Anonymous-visitor gating — the toolbar's "Send snooze digest"
  // surface hides for an unauthed user so the button never fires
  // a fetch that would 401 through to the route's `requireAuth`
  // branch. The button still renders for the signed-out case (so a
  // sign-in flow surfaces a familiar CTA on the page that already
  // hosts it), but the render returns a placeholder chip layered
  // over the actual button so the layout's intent reads consistently
  // even pre-session.
  if (!session?.user?.id) {
    return null;
  }

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      const res = await apiFetch<SendResponse>('/api/alerts/snooze-digest', {
        method: 'POST',
        body: JSON.stringify({}),
        cache: 'no-store',
      });
      if (res.sent) {
        toast.success(
          `Snooze digest emailed (${res.totalAlerts} alert${res.totalAlerts === 1 ? '' : 's'}).`,
        );
      } else if (res.reason === 'no_snoozed') {
        toast.success('No alerts were snoozed — no email sent.');
      } else {
        toast.error('Could not send snooze digest.');
      }
    } catch {
      toast.error('Could not send snooze digest.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void onClick()}
      disabled={pending}
      aria-disabled={pending}
      // The toolbar already carries one outlined sibling (`Hide snoozed`
      // + `<AlertsExportButton/>`); mirror the export button's visual
      // treatment so the `Send snooze digest` CTA blends cleanly.
      className="min-h-11 md:min-h-9"
      data-testid="send-snooze-digest-cta"
    >
      {pending ? (
        <>
          <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> Sending…
        </>
      ) : (
        <>
          <Mail className="mr-1.5 size-3.5" aria-hidden /> Send snooze digest
        </>
      )}
    </Button>
  );
}
