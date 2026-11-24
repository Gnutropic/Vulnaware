// @polsia:user-owned — Top-level data-fetching island for the
// /settings/integrations/notifications page. Owns the single GET to
// /api/team/notifications, hands the saved URL to <NotificationConfigCard/>,
// coordinates the <NotificationTestButton/> send, and re-fetches after both
// Save and Test so the delivery-list reflects the latest state.
//
// Picked up mount time, NO optimistic data — every datum comes from the
// API. Optimistic state would require mirroring the URL locally and racing
// the server-stamped value on the next refresh; the explicit reload is
// cleaner and matches the underlying Request GET semantics.

'use client';

import { BellRing, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { NotificationGetResponse } from '@/lib/contracts/team-notifications';
import { NotificationConfigCard } from './config-card';
import { NotificationDeliveryList } from './delivery-list';
import { NotificationTestButton } from './test-button';

type Snapshot = {
  config: { webhookUrl: string } | null;
  deliveries: import('@/lib/contracts/team-notifications').NotificationDeliveryItem[];
};

export function NotificationsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/team/notifications', {
        schema: NotificationGetResponse,
      });
      setSnapshot({
        config: res.config ? { webhookUrl: res.config.webhookUrl } : null,
        deliveries: res.deliveries,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
      setSnapshot({ config: null, deliveries: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <div className="grid gap-6">
        <header className="grid gap-2">
          <p className="text-caption uppercase tracking-wide text-muted-foreground">Settings</p>
          <h1 className="text-h2 text-foreground">Notifications</h1>
          <p className="max-w-prose text-body text-muted-foreground">
            Fan critical alerts out to the channels your team already lives in.
          </p>
        </header>
        <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <p className="text-caption uppercase tracking-wide text-muted-foreground">Settings</p>
        <h1 className="text-h2 text-foreground">Notifications</h1>
        <p className="max-w-prose text-body text-muted-foreground">
          Fan critical alerts out to the channels your team already lives in. Paste a
          Slack-compatible webhook URL; every new critical alert posts a small JSON payload (alert
          id, title, severity, deep link) to it. Use{' '}
          <strong className="font-medium">Send test alert</strong> to verify the URL before relying
          on it.
        </p>
      </header>

      {error ? (
        <p className="text-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Webhook URL</h2>
          <p className="text-caption text-muted-foreground">
            <BellRing className="mr-1 inline size-3" aria-hidden /> Hidden by default — reveal to
            view, copy to share.
          </p>
        </div>
        <NotificationConfigCard initialUrl={snapshot?.config?.webhookUrl ?? ''} onSaved={reload} />
      </section>

      <section className="grid gap-4">
        <NotificationTestButton onTested={reload} disabled={!snapshot?.config} />
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-h3 text-foreground">Delivery history</h2>
          <p className="text-caption text-muted-foreground">Last 5 attempts — most recent first.</p>
        </div>
        <NotificationDeliveryList rows={snapshot?.deliveries ?? null} />
      </section>
    </div>
  );
}
