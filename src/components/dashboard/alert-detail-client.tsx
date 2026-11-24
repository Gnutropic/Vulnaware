// @polsia:user-owned — Vulnerability detail client island. Fetches one
// `AlertDetail` envelope from GET /api/alerts/[id] and renders the header
// card (CVE link, CVSS, severity, source, description, trigger), the
// affected-assets table, and the "Mark as triaged" action. All data flows
// through apiFetch — no Prisma / server-only imports — and the page above
// is a server component that exports nothing but `metadata`.
//
// Action row cluster (on the Vulnerability card): "Mark as triaged" +
// "Open as Jira ticket" (when webhook configured) + the assignee-only
// "Mark as remediated" toggle + a dialog-driven "Mark as resolved"
// CTA (mounted alongside the existing snooze dropdown so the
// resolve ↔ snooze pair reads as one cluster) + the snooze dropdown
// (1d / 7d / 30d / un-snooze). The resolve CTA flips a page-
// controlled `<AlertsResolveDialog>` open-state, then POSTs
// /api/alerts/[id]/resolve with an optional trimmed `note` and
// replies on `AlertResolveResponse`. The Reopen sibling lives in
// `SuggestedRemediationCard` per the existing state-machine
// division-of-labor — resolve→reopen is symmetric, but each CTA
// is mounted on a distinct card so the operator never sees two
// competing actions on the same row at once.

'use client';

import {
  ArrowLeft,
  BellOff,
  CheckCircle2,
  HandHelping,
  Loader2,
  UserCog,
  UserMinus,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertStatusControl } from '@/components/custom/alert-status-control';
import { AlertActivityCard } from '@/components/dashboard/alert-activity-card';
import { AlertCommentsCard } from '@/components/dashboard/alert-comments-card';
import { AlertNotesCard } from '@/components/dashboard/alert-notes-card';
import {
  AlertScanContextCells,
  AlertScanContextSummary,
} from '@/components/dashboard/alert-scan-context-cells';
import { AlertsExportPdfButton } from '@/components/dashboard/alerts-export-pdf-button';
import { AlertsResolveDialog } from '@/components/dashboard/alerts-resolve-dialog';
import { CveSummaryCard } from '@/components/dashboard/cve-summary-card';
import { ExplainWithAiCard } from '@/components/dashboard/explain-with-ai-card';
import { FixSnippetCard } from '@/components/dashboard/fix-snippet-card';
import { SnoozeCard } from '@/components/dashboard/snooze-card';
import { StakeholderSummaryCard } from '@/components/dashboard/stakeholder-summary-card';
import { SuggestFixStepsCard } from '@/components/dashboard/suggest-fix-steps-card';
import { SuggestedFixCard } from '@/components/dashboard/suggested-fix-card';
import { SuggestedRemediationCard } from '@/components/dashboard/suggested-remediation-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  type AlertDetail,
  AlertDetail as AlertDetailSchema,
  AlertResolveResponse as AlertResolveResponseSchema,
  type AlertStatusMutationResponse,
  AlertTicketResponse as AlertTicketResponseSchema,
} from '@/lib/contracts/alerts';
import {
  type MemberOption,
  MemberOptionList as MemberOptionListSchema,
} from '@/lib/contracts/team';
import { scanSourceLabels } from '@/lib/scan-source-labels';

function severityVariant(sev: string | null): 'destructive' | 'secondary' | 'outline' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium') return 'secondary';
  return 'outline';
}

function sourceVariant(
  source: 'kev' | 'vulncheck' | 'manual',
): 'destructive' | 'secondary' | 'outline' {
  if (source === 'kev') return 'destructive';
  if (source === 'manual') return 'outline';
  return 'secondary';
}

function formatCvss(score: number | null): string {
  if (score == null) return '—';
  return score.toFixed(1);
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

interface AlertDetailClientProps {
  id: string;
  returnHref: string;
}

const UNASSIGNED_OWNER_VALUE = '__unassigned';

export function AlertDetailClient({ id, returnHref }: AlertDetailClientProps) {
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triagePending, setTriagePending] = useState(false);
  const [remediatePending, setRemediatePending] = useState(false);
  // Open-as-Jira-ticket fan-out — separate from triage because the action
  // doesn't mutate the Alert row and there's no state to optimistically
  // flip. The button is disabled while the route POSTs + the helper inserts
  // the delivery row.
  const [ticketPending, setTicketPending] = useState(false);
  // Snooze dropdown — POSTs `{ duration: '1d' | '7d' | '30d' }` for the
  // header dropdown (server stamps `until`); the right-column SnoozeCard
  // continues to send `{ until }` so both surfaces share the same route /
  // contract. Optimistic flip on `detail.snoozedUntil` + `refetch()` on
  // success; the dropdown trigger is locked while in flight so a fast
  // double-click can't fire two POSTs.
  const [snoozePending, setSnoozePending] = useState(false);
  // Picker side-channel — fetched once on mount, lives across the alert's
  // detail GETs (the roster is workspace-scoped, not alert-scoped, so it
  // doesn't need to refetch when the underlying AlertDetail changes).
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [ownerPending, setOwnerPending] = useState(false);
  // Resolve dialog — controlled by the page so the per-row "Mark as
  // resolved" CTA on the Vulnerability card action row opens the same
  // presentational mount as the /alerts bulk bar. The dialog is
  // PRESENTATIONAL — the dialog itself never imports apiFetch; the
  // page owns the open state, the POST, the optimistic flip, and the
  // follow-up refetch. The dialog's `targetLabel` reads `detail.cveId`
  // so the operator's intent on a single row lands on a single row
  // (parity with the bulk path's "N selected alerts" copy).
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  const [resolveDialogSubmitting, setResolveDialogSubmitting] = useState(false);
  // Activity-feed re-fetch trigger. Increments on a successful reopen so
  // the lifecycle card re-fires its `apiFetch` call against
  // `/api/alerts/[id]/activity` — the parent detail GET already pulls
  // the trio through `AlertDetailSchema`, but the activity list lives
  // in its own island with its own fetch + own state. Bumping the
  // dependency on this counter drives the effect in
  // `AlertActivityCard` to re-issue the GET when a reopen lands.
  const [activityBump, setActivityBump] = useState(0);
  // Caller identity — pulled from the better-auth client session so the
  // claim/release buttons can match the caller against the already-
  // fetched roster and resolve the post-claim display name without a
  // second round trip. `useSession()` returns `{ user, session }` where
  // `session` is the session RECORD (token/expiry) and the email lives
  // on the nested `data.user.email`.
  const { data: authSession } = useSession();
  const callerEmail = authSession?.user?.email?.toLowerCase() ?? null;
  const callerMember = callerEmail
    ? (members.find((m) => m.email.toLowerCase() === callerEmail) ?? null)
    : null;

  useEffect(() => {
    let active = true;
    apiFetch(`/api/alerts/${id}`, { schema: AlertDetailSchema })
      .then((payload) => {
        if (active) setDetail(payload);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (!active) return;
        setError(msg);
      });
    return () => {
      active = false;
    };
  }, [id]);

  // Picker roster — workspace-scoped, not alert-scoped, so a single fetch on
  // mount is enough. (The /api/alerts/[id] navigation between alerts already
  // keeps the detail page mounted long enough that re-fetching the roster
  // would be churn for zero benefit.)
  useEffect(() => {
    let active = true;
    apiFetch('/api/team/members', { schema: MemberOptionListSchema })
      .then((payload) => {
        if (active) setMembers(payload.items);
      })
      .catch(() => {
        // Soft-fail — the picker renders a "members unavailable" hint but
        // the detail page still works.
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refetch() {
    try {
      const payload = await apiFetch(`/api/alerts/${id}`, { schema: AlertDetailSchema });
      setDetail(payload);
      // Bump the activity-card refresh key on every detail refetch
      // so the lifecycle timeline re-fires its apiFetch on every
      // server-authoritative stamp update (a reopen, a resolve, a
      // re-resolve, an owner flip, etc.). Cheap integer increment;
      // the activity card keys off this number in its useEffect.
      setActivityBump((n) => n + 1);
    } catch {
      /* keep existing detail on transient refetch failure; the button
         already flipped optimistically. A re-mount will try again. */
    }
  }

  function applySavedStatus(saved: AlertStatusMutationResponse): void {
    setDetail((current) =>
      current
        ? {
            ...current,
            status: saved.status,
            statusChangedAt: saved.statusChangedAt,
            acknowledgedAt: saved.acknowledgedAt,
            snoozedUntil: saved.snoozedUntil,
            falsePositiveReason: saved.falsePositiveReason,
            closedAt: saved.closedAt,
            closedBy: saved.closedBy,
            closingNote: saved.closingNote,
            reopenedAt: saved.reopenedAt,
            reopenedBy: saved.reopenedBy,
            reopenReason: saved.reopenReason,
          }
        : current,
    );
    setActivityBump((count) => count + 1);
  }

  async function handleOwnerChange(nextOwnerId: string | null) {
    if (!detail || ownerPending) return;
    setOwnerPending(true);
    // Optimistic flip — the server's resolution (ownership name, plus any
    // FK validation) returns asynchronously and we reconcile on success.
    // For the "assign member" branch we derive the display name from the
    // already-fetched members list so the picker reflects the choice
    // before the round trip. For the "unassign" branch both fields are
    // null.
    const optimisticOwnerName =
      nextOwnerId === null ? null : (members.find((m) => m.id === nextOwnerId)?.name ?? null);
    const optimistic: AlertDetail = {
      ...detail,
      ownerId: nextOwnerId,
      ownerName: optimisticOwnerName,
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/owner`, {
        method: 'PATCH',
        body: JSON.stringify({ ownerId: nextOwnerId }),
      });
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Owner update failed.';
      toast.error(msg);
      // Revert + reconcile with the server so transient failures don't
      // strand the user on a stale display.
      if (detail) setDetail(detail);
      await refetch();
    } finally {
      setOwnerPending(false);
    }
  }

  // Take ownership — flips `Alert.ownerId` to the caller's
  // WorkspaceMember.id. Same optimistic-flip + lock + revert pattern as
  // `handleOwnerChange`. Display name resolves from the already-fetched
  // roster so the post-claim header swaps the "Unowned" label to the
  // caller's email before the round trip completes.
  async function handleClaim() {
    if (!detail || ownerPending) return;
    // The caller IS in the roster — `requireTeamRole('member')` on the
    // server gates the route on a matching WorkspaceMember row, so the
    // session-loading branch lands on "wait for refetch to reconcile".
    const optimisticId = callerMember?.id ?? detail.ownerId ?? null;
    const optimisticName = callerMember?.name ?? null;
    setOwnerPending(true);
    const optimistic: AlertDetail = {
      ...detail,
      ownerId: optimisticId,
      ownerName: optimisticName,
      me: { ...detail.me, isAssignee: callerMember != null },
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/claim`, { method: 'POST' });
      toast.success('You now own this alert.');
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Claim failed.';
      toast.error(msg);
      if (detail) setDetail(detail);
      await refetch();
    } finally {
      setOwnerPending(false);
    }
  }

  // Release ownership — clears `Alert.ownerId` back to null. Same
  // optimistic-flip + lock + revert pattern as `handleClaim`. The
  // button is gated on `detail.me.isAssignee` so the typical user never
  // reaches the 409 `not_owner` branch; that branch only fires on a
  // stale click race after the picker flipped ownership to someone
  // else.
  async function handleRelease() {
    if (!detail || ownerPending) return;
    setOwnerPending(true);
    const optimistic: AlertDetail = {
      ...detail,
      ownerId: null,
      ownerName: null,
      me: { ...detail.me, isAssignee: false },
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/release`, { method: 'POST' });
      toast.success('Ownership released.');
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Release failed.';
      toast.error(msg);
      if (detail) setDetail(detail);
      await refetch();
    } finally {
      setOwnerPending(false);
    }
  }

  async function handleTriage() {
    if (!detail || triagePending) return;
    setTriagePending(true);
    // Optimistic flip — the server stamp arrives asynchronously; if the
    // request fails we revert. Re-fetch after the POST so the visible
    // acknowledgedAt matches the actual DB value (the server is the
    // authority for the timestamp).
    const optimistic: AlertDetail = {
      ...detail,
      acknowledgedAt: new Date().toISOString(),
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/triage`, { method: 'POST' });
      toast.success('Alert marked as triaged.');
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Triage failed.';
      toast.error(msg);
      if (detail) setDetail(detail);
    } finally {
      setTriagePending(false);
    }
  }

  async function handleRemediate() {
    if (!detail || remediatePending) return;
    setRemediatePending(true);
    const isNowRemediated = detail.remediatedAt !== null;
    const set = isNowRemediated ? 'clear' : 'now';
    const optimistic: AlertDetail = {
      ...detail,
      remediatedAt: isNowRemediated ? null : new Date().toISOString(),
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/remediate`, {
        method: 'PATCH',
        body: JSON.stringify({ set }),
      });
      toast.success(set === 'now' ? 'Marked as remediated.' : 'Remediation cleared.');
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Remediate failed.';
      toast.error(msg);
      if (detail) setDetail(detail);
      await refetch();
    } finally {
      setRemediatePending(false);
    }
  }

  // Mark as resolved — sister to handleSnooze / handleRemediate: a
  // small dialog-collects-note-then-POSTs cycle. POSTs to
  // /api/alerts/[id]/resolve with the (whitespace-trimmed, optional)
  // closing note and replies on `AlertResolveResponse` so the
  // optimistic flip reads the server-authoritative statusChangedAt
  // stamp + the close-stamp trio directly off the envelope. The CTA
  // is hidden when `detail.status === 'resolved' || 'false_positive'`
  // so a closed or suppressed row doesn't surface a no-op control;
  // mirrors the snooze dropdown's visual detail that surfacing the
  // action on an already-resolved row is meaningless. The Reopen
  // sibling lives in `SuggestedRemediationCard` per the existing
  // state-machine division-of-labor — resolve → reopen is wired to
  // two distinct cards so the operator's flow matches the
  // lifecycle.
  async function submitMarkResolved(note: string) {
    if (!detail || resolveDialogSubmitting) return;
    setResolveDialogSubmitting(true);
    const trimmed = note.trim();
    const body = trimmed.length > 0 ? { note: trimmed } : {};
    // Optimistic flip — mirror the server-confirmed behavior on
    // every visible field: status, statusChangedAt (the bread-and-
    // butter refresh on every transition), and the close-stamp
    // trio (closedAt, closedBy, closingNote). `closedBy` will be
    // set to the caller's User.id by the route; we already mirror
    // it via the envelope stamp on success, so the optimistic flip
    // just leaves the prior null in place and the server stamp
    // lands on the refetch.
    const nowIso = new Date().toISOString();
    const optimistic: AlertDetail = {
      ...detail,
      status: 'resolved',
      statusChangedAt: nowIso,
      closedAt: nowIso,
      closingNote: trimmed.length > 0 ? trimmed : null,
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify(body),
        schema: AlertResolveResponseSchema,
      });
      toast.success('Alert marked as resolved.');
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Resolve failed.';
      toast.error(msg);
      if (detail) setDetail(detail);
      await refetch();
    } finally {
      setResolveDialogSubmitting(false);
    }
  }

  // Snooze action — powers the `Mark as remediated`-row dropdown AND the
  // "Un-snooze" item. Mirrors `handleRemediate`'s optimistic-flip + lock +
  // toast + refetch pattern: stamps the row's `snoozedUntil` to a server-
  // authoritative future moment for `{ duration }` (server computes
  // `now + WINDOW_MS[duration]`) and clears it for `'clear'`. The
  // `refetch()` reconciles with the server's row snapshot so the header
  // pill, the right-column SnoozeCard, and the dropdown trigger all stay
  // lockstep with one wire shape.
  async function handleSnooze(action: '1d' | '7d' | '30d' | 'clear') {
    if (!detail || snoozePending) return;
    setSnoozePending(true);
    const next =
      action === 'clear'
        ? null
        : new Date(
            Date.now() +
              (action === '1d' ? 86_400_000 : action === '7d' ? 7 * 86_400_000 : 30 * 86_400_000),
          ).toISOString();
    const optimistic: AlertDetail = {
      ...detail,
      snoozedUntil: next,
    };
    setDetail(optimistic);
    try {
      await apiFetch(`/api/alerts/${id}/snooze`, {
        method: 'POST',
        body:
          action === 'clear'
            ? JSON.stringify({ until: null })
            : JSON.stringify({ duration: action }),
      });
      toast.success(
        action === 'clear'
          ? 'Snooze cleared.'
          : `Snoozed for ${action === '1d' ? '1 day' : action === '7d' ? '7 days' : '30 days'}.`,
      );
      await refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Snooze failed.';
      toast.error(msg);
      if (detail) setDetail(detail);
      await refetch();
    } finally {
      setSnoozePending(false);
    }
  }

  async function handleTicket() {
    if (!detail || ticketPending) return;
    setTicketPending(true);
    try {
      const result = await apiFetch(`/api/alerts/${id}/ticket`, {
        method: 'POST',
        schema: AlertTicketResponseSchema,
      });
      if (result.ok) {
        toast.success('Jira ticket sent.');
      } else {
        // The 503 branch lands here only on a stale click after the webhook
        // was removed while the page was mounted. Re-derive `webhookConfigured`
        // on the next page mount; for now surface the typed error so the
        // operator sees WHY nothing went.
        const reason = result.error ?? `HTTP ${result.status ?? '???'}`;
        toast.error(`Jira ticket failed: ${reason}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Jira ticket failed.';
      toast.error(msg);
    } finally {
      setTicketPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="sticky top-14 z-30 -mx-gutter max-w-[100vw] bg-background/95 px-gutter py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-11 w-fit md:min-h-0">
          <Link href={returnHref}>
            <ArrowLeft className="size-4" aria-hidden /> Back to alerts
          </Link>
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">Couldn’t load this alert</CardTitle>
            <CardDescription>
              The alert may have been removed, or this id belongs to a different team. Try returning
              to the alerts list.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={returnHref}>
                <ArrowLeft className="size-4" aria-hidden /> Back to alerts
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : !detail ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading alert…
        </div>
      ) : (
        <>
          {/* AI brief — gates on the parent's `detail` being loaded so the
              sub-island gets the CVE id + asset row up-front. The summary
              fetch happens inside CveSummaryCard (own /api call); the page
              layout never blocks on it. */}
          <CveSummaryCard alertId={id} cveId={detail.cveId} asset={detail.asset} />

          {/* Suggested fix — sits between the summary and the owner picker
              so a teammate triaging the AI brief sees the remediation
              immediately, then claims the work. Its own island owns the
              /api call; no state is shared with the summary card above. */}
          <SuggestedFixCard alertId={id} cveId={detail.cveId} asset={detail.asset} />

          {/* Owner picker. Sits RIGHT after the AI brief so a teammate
              reviewing the summary can immediately claim the work, before
              scrolling into the spec/asset details. The picker is bound
              to `detail.ownerId`; the only Cancelled branch is "unassign".
              Members list is fetched once on mount via /api/team/members.
              The two sibling CTAs ("Take ownership" / "Release
              ownership") sit directly under the picker: the first is
              the brief's one-click claim (POSTs /api/alerts/[id]/claim
              and stamps `Alert.ownerId` to the caller's
              WorkspaceMember.id); the second is the symmetric release
              (POSTs /api/alerts/[id]/release and clears it back to
              null). Both share the `ownerPending` lock with the
              picker so a stale click race never lands on a torn
              state. The "currently owned by you" line above the
              picker reflects the brief's "page header swaps the
              'Unowned' label to your email" surface — pulled from the
              already-fetched roster so the swap is instant. */}
          <Card className="border-border/80 bg-card shadow-sm">
            <CardHeader className="space-y-2">
              <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Owner
              </CardDescription>
              <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
                <UserCog className="size-4 text-brand-500" aria-hidden />
                Assign this CVE to a team member
              </CardTitle>
              <CardDescription className="text-caption text-muted-foreground">
                Picking a colleague claims this CVE; selecting Unassigned clears the assignment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3 sm:max-w-md">
                {/* Currently-owned-by stamp — the brief's "page header
                    swaps the 'Unowned' label to your email" surface.
                    Looks the caller up against the already-fetched
                    roster via the better-auth session; falls back to
                    "Unowned" when no WorkspaceMember row is found OR
                    when the FK is null. The email copy uses the caller's
                    roster email rather than toLocaleString-rendered
                    data so a viewer of the page sees exactly the
                    address that just got stamped onto the row. */}
                <div
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-body text-foreground"
                  data-testid="alert-owner-current"
                >
                  {detail.ownerId ? (
                    detail.me.isAssignee ? (
                      <>
                        <HandHelping className="size-4 text-brand-500" aria-hidden />
                        <span>
                          You own this CVE as{' '}
                          <span className="font-mono text-caption text-foreground">
                            {callerMember?.email ?? detail.ownerName ?? 'you'}
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <UserCog className="size-4 text-brand-500" aria-hidden />
                        <span>
                          Owned by{' '}
                          <span className="font-mono text-caption text-foreground">
                            {members.find((m) => m.id === detail.ownerId)?.email ??
                              detail.ownerName ??
                              'unknown member'}
                          </span>
                        </span>
                      </>
                    )
                  ) : (
                    <>
                      <UserMinus className="size-4 text-muted-foreground" aria-hidden />
                      <span className="text-muted-foreground">
                        Unowned — no one has claimed this CVE yet.
                      </span>
                    </>
                  )}
                </div>
                <label
                  htmlFor="alert-owner"
                  className="text-eyebrow uppercase tracking-wider text-muted-foreground"
                >
                  Reassign
                </label>
                <Select
                  value={detail.ownerId ?? UNASSIGNED_OWNER_VALUE}
                  onValueChange={(value) =>
                    handleOwnerChange(value === UNASSIGNED_OWNER_VALUE ? null : value)
                  }
                  disabled={ownerPending}
                >
                  <SelectTrigger
                    id="alert-owner"
                    aria-label="Alert owner"
                    aria-disabled={ownerPending}
                    className="bg-card"
                  >
                    <SelectValue placeholder="Unassigned">
                      {detail.ownerName ?? 'Unassigned'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="center"
                    className="max-w-[calc(100vw-1rem)]"
                  >
                    <SelectItem value={UNASSIGNED_OWNER_VALUE}>Unassigned</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {/* Take ownership — primary one-click claim. Visible
                      only when the FK is null so a teammate with the
                      alert already assigned can't accidentally
                      reassign it to themselves. */}
                  {detail.ownerId === null ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleClaim()}
                      disabled={ownerPending}
                      aria-disabled={ownerPending}
                    >
                      {ownerPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                          Claiming…
                        </>
                      ) : (
                        <>
                          <HandHelping className="size-4" aria-hidden />
                          Take ownership
                        </>
                      )}
                    </Button>
                  ) : null}
                  {/* Release ownership — visible only when the server
                      says the caller is the assignee. The
                      server-stamped `me.isAssignee` gate ensures the
                      post-release 409 branch only fires on a stale
                      click race (e.g. another tab flipped ownership). */}
                  {detail.ownerId !== null && detail.me.isAssignee ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleRelease()}
                      disabled={ownerPending}
                      aria-disabled={ownerPending}
                    >
                      {ownerPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                          Releasing…
                        </>
                      ) : (
                        <>
                          <UserMinus className="size-4" aria-hidden />
                          Release ownership
                        </>
                      )}
                    </Button>
                  ) : null}
                </div>
                {ownerPending ? (
                  <div className="flex items-center gap-2 text-caption text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden /> Updating owner…
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Snooze — sits next to the owner picker since both are
              per-row operator controls. The card consumes
              `detail.snoozedUntil` from the latest GET and refetches via
              `onChanged` so the stamp stays consistent with the server. */}
          <SnoozeCard alertId={id} initialSnoozedUntil={detail.snoozedUntil} onChanged={refetch} />

          <Card className="border-border/80 bg-card shadow-sm">
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                    Vulnerability
                  </CardDescription>
                  {detail.cveId ? (
                    <CardTitle className="font-mono text-h3 tracking-tight text-foreground">
                      <a
                        href={`https://nvd.nist.gov/vuln/detail/${detail.cveId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        {detail.cveId}
                      </a>
                    </CardTitle>
                  ) : (
                    <CardTitle className="font-display text-h3 tracking-tight text-foreground">
                      Unknown CVE
                    </CardTitle>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={severityVariant(detail.severity)}
                    className="font-mono uppercase tracking-wider"
                  >
                    {detail.severity ?? 'unknown'}
                  </Badge>
                  <Badge
                    variant={sourceVariant(detail.source)}
                    className="font-mono uppercase tracking-wider"
                  >
                    {detail.source === 'kev'
                      ? 'KEV'
                      : detail.source === 'manual'
                        ? 'Manual'
                        : 'VulnCheck'}
                  </Badge>
                  <AlertStatusControl
                    alertId={id}
                    status={detail.status}
                    onSaved={applySavedStatus}
                  />
                  <Badge variant="outline" className="font-mono text-caption">
                    Triggered by {scanSourceLabels[detail.triggeredBy ?? 'manual']}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                    CVSS
                  </dt>
                  <dd className="font-mono text-h4 text-foreground">
                    {formatCvss(detail.cvssScore)}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                    Detected
                  </dt>
                  <dd className="text-body text-foreground">{formatTimestamp(detail.createdAt)}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                    Acknowledged
                  </dt>
                  <dd className="text-body text-foreground">
                    {detail.acknowledgedAt ? (
                      <span className="inline-flex items-center gap-1.5">
                        <CheckCircle2 className="size-4 text-brand-500" aria-hidden="true" />
                        {formatTimestamp(detail.acknowledgedAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not yet triaged</span>
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                    Remediated
                  </dt>
                  <dd className="text-body text-foreground">
                    {detail.remediatedAt ? (
                      <span className="inline-flex items-center gap-1.5">
                        <CheckCircle2 className="size-4 text-brand-500" aria-hidden="true" />
                        {formatTimestamp(detail.remediatedAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not yet remediated</span>
                    )}
                  </dd>
                </div>
              </dl>
              {detail.description ? (
                <p className="max-w-prose text-body text-foreground">{detail.description}</p>
              ) : (
                <p className="max-w-prose text-body text-muted-foreground">
                  No CVE description available — the entry may not have been ingested yet.
                </p>
              )}
              {/* Header pill — paints "Snoozed until …" when the row's
                  snooze window is still in the future. Stamped at the top
                  of the action card so the operator sees the active
                  silence before reaching the dropdown. Reads the same
                  `detail.snoozedUntil` that the right-column SnoozeCard
                  reads so the two surfaces stay lockstep. */}
              {detail.snoozedUntil && Date.parse(detail.snoozedUntil) > Date.now() ? (
                <div
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-body text-foreground"
                  data-testid="alert-snooze-pill"
                >
                  <BellOff className="size-4 text-brand-500" aria-hidden />
                  <span>
                    Snoozed until{' '}
                    <span className="font-mono text-caption">
                      {formatTimestamp(detail.snoozedUntil)}
                    </span>
                  </span>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant={detail.acknowledgedAt ? 'outline' : 'default'}
                  onClick={handleTriage}
                  disabled={detail.acknowledgedAt != null || triagePending}
                  aria-disabled={detail.acknowledgedAt != null || triagePending}
                >
                  {triagePending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Marking…
                    </>
                  ) : detail.acknowledgedAt ? (
                    <>
                      <CheckCircle2 className="size-4" aria-hidden />
                      Triaged
                    </>
                  ) : (
                    'Mark as triaged'
                  )}
                </Button>
                {detail.webhookConfigured ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleTicket}
                    disabled={ticketPending}
                    aria-disabled={ticketPending}
                  >
                    {ticketPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden /> Sending…
                      </>
                    ) : (
                      'Open as Jira ticket'
                    )}
                  </Button>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <Link href="/settings/integrations/notifications">Open as Jira ticket</Link>
                  </Button>
                )}
                {detail.me.isAssignee ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={detail.remediatedAt ? 'default' : 'outline'}
                    onClick={() => void handleRemediate()}
                    disabled={remediatePending}
                    aria-disabled={remediatePending}
                    data-testid="remediate-toggle"
                  >
                    {remediatePending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        {detail.remediatedAt ? 'Clearing…' : 'Marking…'}
                      </>
                    ) : detail.remediatedAt ? (
                      <>
                        <CheckCircle2 className="size-4" aria-hidden />
                        Undo remediation
                      </>
                    ) : (
                      'Mark as remediated'
                    )}
                  </Button>
                ) : null}
                {/* Mark as resolved — sits next to the snooze dropdown
                    so the three lifecycle controls (remediate / resolve
                    / snooze) read as one cluster on the action row.
                    Visible to any team member (gated only by status,
                    NOT by `isAssignee` — the resolve branch is what
                    the team uses to CLOSE the alert regardless of who
                    owns the row). Hidden on `status === 'resolved'`
                    and `status === 'false_positive'` rows because
                    surfacing the action on a closed / suppressed row
                    is a no-op; the Reopen sibling lives in
                    `SuggestedRemediationCard` per the existing state-
                    machine division-of-labor. The dialog mount is
                    page-controlled (state below); this CTA flips
                    `resolveDialogOpen = true` to surface it. */}
                {detail.status !== 'resolved' && detail.status !== 'false_positive' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setResolveDialogOpen(true);
                    }}
                    disabled={resolveDialogSubmitting}
                    aria-disabled={resolveDialogSubmitting}
                    data-testid="alert-mark-resolved-button"
                  >
                    {resolveDialogSubmitting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        Resolving…
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="size-4" aria-hidden />
                        Mark as resolved
                      </>
                    )}
                  </Button>
                ) : null}
                {/* Export PDF — download affordance on the right of the
                    action row cluster, next to the Snooze dropdown, so
                    any team member can snapshot the alert as a
                    multi-section PDF without leaving the detail page.
                    Non-mutating read; mounted unconditionally because
                    the route is gated `requireTeamRole('member')`
                    (same posture as the on-screen detail). The button
                    is locked while in flight so fast double-clicks
                    can't fire two downloads against the same alert. */}
                <AlertsExportPdfButton alertId={id} />
                {/* Snooze dropdown — sits next to "Mark as remediated"
                    so the operator can silence the row in one click
                    without scrolling back to the right-column SnoozeCard.
                    The trigger is locked while a snooze POST is in
                    flight so a fast double-click can't fire two
                    requests on the same alert. Three duration options
                    (1d / 7d / 30d) plus an "Un-snooze" item visible only
                    when the row is actively snoozed — the explicit
                    Un-snooze path is required so the dropdown can
                    reverse its own action without leaving the action
                    row. The dropdown does NOT require assignee — any
                    team member can mute their own list. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={snoozePending}
                      aria-disabled={snoozePending}
                      data-testid="snooze-dropdown-trigger"
                    >
                      {snoozePending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                          Snoozing…
                        </>
                      ) : (
                        <>
                          <BellOff className="size-4" aria-hidden />
                          Snooze
                        </>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem]">
                    <DropdownMenuItem
                      onSelect={() => void handleSnooze('1d')}
                      data-testid="snooze-option-1d"
                    >
                      Silence for 1 day
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void handleSnooze('7d')}
                      data-testid="snooze-option-7d"
                    >
                      Silence for 7 days
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void handleSnooze('30d')}
                      data-testid="snooze-option-30d"
                    >
                      Silence for 30 days
                    </DropdownMenuItem>
                    {detail.snoozedUntil && Date.parse(detail.snoozedUntil) > Date.now() ? (
                      <DropdownMenuItem
                        onSelect={() => void handleSnooze('clear')}
                        data-testid="snooze-option-clear"
                      >
                        Un-snooze
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardContent>
          </Card>

          {/* AI priority rationale and remediation explanation use the
              alert's current data and are cached separately from its
              stored severity. */}
          <ExplainWithAiCard
            key={id}
            alertId={id}
            cveId={detail.cveId}
            severity={detail.severity}
            cvssScore={detail.cvssScore}
            asset={detail.asset}
            initialText={detail.lastExplanationText}
            initialGeneratedAt={detail.lastExplainedAt}
          />

          {/* One-shot "Suggest fix steps with AI" mount removed —
              the no-persist /api/alerts/[id]/suggest-fix sibling
              would re-bill the LLM on every click and contradict
              the per-alert caching requirement. The
              cached /api/alerts/[id]/suggested-fix island is now
              mounted directly above <AlertActivityCard/> (below). */}

          {/* Streamed "Suggested remediation" — sits between the prose
              explain panel and the asset table so an operator who has
              just walked through the CVE walks straight into a
              version-line / patch-KB checklist. Streams through
              /api/alerts/[id]/remediation/stream (raw fetch, same posture
              as the explain card) AND exposes a Mark-as-resolved POST
              that hits /api/alerts/[id]/resolve — `onResolved` is the
              same `refetch` handler used by SnoozeCard + AlertCommentsCard
              so the parent detail refetch picks up the new
              `statusChangedAt` stamp. A sibling Reopen CTA flips
              back to 'open' via POST /api/alerts/[id]/reopen —
              `onReopened` reconciles the same `refetch` handler so the
              resolve ↔ reopen state machine is symmetric. */}
          <SuggestedRemediationCard
            alertId={id}
            cveId={detail.cveId}
            asset={detail.asset}
            alreadyResolved={detail.status === 'resolved'}
            onResolved={refetch}
            onReopened={refetch}
          />

          {/* Streamed "Fix preview" — sits RIGHT after the Suggested
              remediation card so an operator who has just walked through
              the version-line / patch-KB checklist gets the
              machine-pasteable code block before handing the human-
              language brief to leadership. Streams through
              /api/alerts/[id]/fix-snippet/stream (raw fetch, same
              posture as the remediation + stakeholder-summary cards)
              and renders a fenced `<pre><code>` so the operator's
              paste preserves the exact byte layout — a package version
              bump, a Dockerfile RUN, an nginx server block, an Apache
              directive, an sshd_config toggle, a sysctl invocation, or
              a one-line shell command. No Mark-as-resolved or Reopen
              sibling CTAs here — those CTAs stay with the Suggest
              remediation card per the existing state-machine division
              of labor; this card is read-only on the resolve/reopen
              pair. */}
          <FixSnippetCard alertId={id} cveId={detail.cveId} asset={detail.asset} />

          {/* Cached "Suggest fix steps with AI" — mounted DIRECTLY
              ABOVE <AlertActivityCard/> so the brief's
              "near the remediation-activity timeline" position is
              respected. The earlier mount order (Explain →
              SuggestFixCard/SuggestFixStepsCard → Suggested-
              Remediation → FixSnippet) reads bottom-up; this
              island mirrors the brief's flow that the operator
              reviews the activity timeline IMMEDIATELY after they
              generate a checklist, so the click-to-generate panel
              sits adjacent to (above) the timeline. The new island
              wires to the CACHED /api/alerts/[id]/suggested-fix
              route (per-alert AlertCveFix upsert); the post-click
              state persists across reloads. The client-side no-CVE
              gate renders a muted panel for `detail.cveId ===
              null | '' | 'UNKNOWN'` and the server-side no-CVE
              guard inside the POST short-circuits before tokens
              are spent on alerts without an ingested CVE yet. */}
          <SuggestFixStepsCard
            alertId={id}
            cveId={detail.cveId}
            description={detail.description}
            asset={detail.asset}
          />

          {/* Lifecycle timeline — sits right ABOVE the assignee update-
              note thread so the visually-grouped chronology reads
              top-down: an operator who has just hit the Reopen CTA
              sees the new event mount in the timeline, then keeps
              scrolling into the assignee conversation. The activity
              card re-fires its apiFetch on every mount; the parent
              bumps `activityBump` on every successful refetch so the
              React `key` flips and the island remounts, cascading a
              re-fetch through without coupling the activity state to
              the parent's detail envelope. Soft-fail is built in for
              the read; a 404 here reads as the row's normal
              never-reopened state. */}
          <AlertActivityCard
            key={activityBump}
            alertId={id}
            lastActivityAt={detail.lastActivityAt}
          />

          {/* Assignee update-note thread. Sits BELOW the fix-preview
              panel and ABOVE the stakeholder summary so the assignee
              can paste progress notes alongside the machine-pasteable
              code block, then hand the leadership brief off without
              scrolling. `isAssignee` is server-derived from
              `Alert.ownerId === <caller's WorkspaceMember.id>`, gated
              on the existing detail GET so the composer mount never
              needs a second round trip. `refetch` is the same handler
              SnoozeCard / FixSnippetCard take — a successful POST
              refreshes the parent detail so any flow that the new
              comment implies (new owner, new acknowledgement) is
              reflected immediately. */}
          <AlertCommentsCard alertId={id} isAssignee={detail.me.isAssignee} onChanged={refetch} />

          {/* Streamed "Stakeholder summary" — sits RIGHT after the
              Suggested remediation card so an operator who has just
              walked through the version-line / patch-KB checklist can
              hand the leadership summary off without scrolling back up.
              Streams through /api/alerts/[id]/summary/stream (raw
              fetch, same posture as the explain + remediation cards)
              and renders a single executive-brief paragraph aimed at
              non-technical leadership. No Mark-as-resolved or Reopen
              sibling CTAs here — the brief already articulates the
              "what to verify post-fix" beat, so the resolve control
              below is the natural follow-up action. */}
          <StakeholderSummaryCard alertId={id} cveId={detail.cveId} asset={detail.asset} />

          <Card className="border-border/80 bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-h4 text-foreground">Affected assets</CardTitle>
              <CardDescription>
                The asset the underlying vulnerability finding was attached to. Future revisions
                will surface every team asset carrying this CVE.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="hidden w-[12rem] md:table-cell">Asset ID</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead className="hidden w-[10rem] md:table-cell">Port</TableHead>
                    <TableHead className="hidden w-[10rem] md:table-cell">Risk score</TableHead>
                    <TableHead className="hidden w-[11rem] md:table-cell">Latest scan</TableHead>
                    <TableHead className="hidden w-[10rem] md:table-cell">Scan outcome</TableHead>
                    <TableHead className="hidden w-[10rem] md:table-cell">Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.asset.id ? (
                    <TableRow key={detail.asset.id}>
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        {detail.asset.id}
                      </TableCell>
                      <TableCell className="font-mono text-caption">
                        {detail.asset.host ? (
                          <span className="inline-flex max-w-full flex-wrap items-baseline gap-1">
                            <Button asChild variant="link" size="sm" className="px-0">
                              <Link
                                href={`/assets/${encodeURIComponent(detail.asset.host)}`}
                                className="break-all font-mono text-caption"
                              >
                                {detail.asset.host}
                              </Link>
                            </Button>
                            {detail.asset.ip ? (
                              <span className="break-all text-muted-foreground">
                                ({detail.asset.ip}:{detail.asset.port}/{detail.asset.protocol})
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        <AlertScanContextSummary
                          latestScanAt={detail.asset.latestScanAt}
                          latestScanStatus={detail.asset.latestScanStatus}
                          hasCompletedScan={detail.asset.hasCompletedScan}
                        />
                      </TableCell>
                      <TableCell className="hidden font-mono text-caption md:table-cell">
                        {detail.asset.port}/{detail.asset.protocol}
                      </TableCell>
                      <TableCell className="hidden font-mono text-caption md:table-cell">
                        {detail.asset.riskScore != null && Number.isFinite(detail.asset.riskScore)
                          ? `${detail.asset.riskScore.toFixed(2)} /10`
                          : '—'}
                      </TableCell>
                      <AlertScanContextCells
                        latestScanAt={detail.asset.latestScanAt}
                        latestScanStatus={detail.asset.latestScanStatus}
                        hasCompletedScan={detail.asset.hasCompletedScan}
                      />
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        {formatTimestamp(detail.asset.lastSeen)}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow>
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        —
                      </TableCell>
                      <TableCell className="text-caption text-muted-foreground">
                        Unavailable
                      </TableCell>
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        —
                      </TableCell>
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        —
                      </TableCell>
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        —
                      </TableCell>
                      <TableCell className="hidden text-caption text-muted-foreground md:table-cell">
                        Unavailable
                      </TableCell>
                      <TableCell className="hidden font-mono text-caption text-muted-foreground md:table-cell">
                        —
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Shift-handoff notes pane. Mounted LAST inside the resolved
              branch, right after the Affected-assets table, so a teammate
              scrolling top-to-bottom reads the lifecycle (activity +
              assignee thread) and the asset context before reaching the
              open handoff field at the very bottom. The pane is freely-
              readable AND freely-postable by any signed-in team member —
              see AlertNotesCard for the per-row composer / list details. */}
          <AlertNotesCard alertId={id} />

          {/* Resolve dialog — controlled by the page so the per-row
              "Mark as resolved" CTA on the Vulnerability card action
              row opens the same presentational mount as the /alerts
              bulk bar. Page-owned state (open + submitting); dialog
              is presentational, mirrors alerts-resolve-dialog.tsx's
              reuse contract. Modal submits through `submitMarkResolved`
              which POSTs /api/alerts/[id]/resolve with an optional
              trimmed `note` and replies on `AlertResolveResponse`. The
              dialog closes on either Submit (with the trimmed note) or
              Cancel, and is always disabled mid-flight so a fast double-
              click can't fire a second fan-out against the row. Mounted
              on every render so a dialog-open cycle never blocks on a
              re-mount — sentinel-presentational. */}
          <AlertsResolveDialog
            open={resolveDialogOpen}
            onOpenChange={(next) => {
              if (resolveDialogSubmitting && !next) return;
              setResolveDialogOpen(next);
            }}
            onSubmit={(note) => {
              void submitMarkResolved(note).then(() => {
                setResolveDialogOpen(false);
              });
            }}
            submitting={resolveDialogSubmitting}
            targetLabel={detail?.cveId ?? 'this alert'}
          />
        </>
      )}
    </div>
  );
}
