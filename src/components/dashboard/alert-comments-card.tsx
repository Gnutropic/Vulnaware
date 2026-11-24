// @polsia:user-owned — Per-alert update-note thread with an
// assignee-only composer. Owns GET /api/alerts/[id]/comments on mount
// and POSTs back to the same path on submit. The page-level detail
// island passes `isAssignee` (server-derived from AlertDetail.me).
//
// Body policy: trimmed, min 1, max 4000 (server-enforced — refine
// upstream). Empty after trim → form-level guard, no POST.
// Failure posture: apiFetch throws on non-2xx; on 400 (validation) we
// apply the message to the textarea via inline `role="alert"` text. On
// any other failure we toast and revert the optimistic insert.
//
// Mobile audit posture: composer primary submit uses `min-h-11
// md:min-h-0`, body wraps with `flex-col` and `max-w-prose` for each
// note, no horizontal scroll trap. Optimistic prepend flags a row as
// `pending` so a tap during a POST shows a spinner instead of a stale
// row.

'use client';

import { Loader2, MessageSquarePlus, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import {
  type AlertCommentItem,
  AlertCommentItem as AlertCommentItemSchema,
  AlertCommentList,
} from '@/lib/contracts/alert-comments';

interface AlertCommentsCardProps {
  alertId: string;
  isAssignee: boolean;
  onChanged?: () => void;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'ready'; items: AlertCommentItem[] }
  | { kind: 'error'; message: string };

type ComposerState = {
  body: string;
  pending: boolean;
  fieldError: string | null;
};

const EMPTY_COMPOSER: ComposerState = { body: '', pending: false, fieldError: null };
const MAX_BODY = 4000;

// 60-second tick keeps visible ages from going stale — old notes
// re-evaluate "3 minutes ago" → "4 minutes ago" inside the open tab
// without a refetch. Cheap; cleans up on unmount.
const RELATIVE_TICK_MS = 60_000;

// Bucket + formatter for the "<N> seconds ago" stamp on each note.
// Hidden source of truth: the row's ISO createdAt stays on the
// element's `title` attr so an operator hovering gets the absolute
// stamp verbatim (avoids the second parse path).
const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function formatRelative(value: string, now: number): string {
  const d = new Date(value);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return '—';
  const deltaSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 45) return RTF.format(deltaSec, 'second');
  if (abs < 45 * 60) return RTF.format(Math.round(deltaSec / 60), 'minute');
  if (abs < 22 * 60 * 60) return RTF.format(Math.round(deltaSec / 3600), 'hour');
  if (abs < 26 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / 86_400), 'day');
  if (abs < 320 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / (7 * 86_400)), 'week');
  if (abs < 365 * 24 * 60 * 60) return RTF.format(Math.round(deltaSec / (30 * 86_400)), 'month');
  return RTF.format(Math.round(deltaSec / (365 * 86_400)), 'year');
}

function authorLabel(item: AlertCommentItem): string {
  return item.authorName ?? 'Unknown';
}

function avatarInitials(name: string): string {
  // First letter of each whitespace-separated token — keeps the
  // placeholders short and tidy when the user types "Sarah Lin" vs
  // "Q". Unknown authors render as "U".
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

export function AlertCommentsCard({ alertId, isAssignee, onChanged }: AlertCommentsCardProps) {
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  // Counter bumps after every successful POST so the pending note's key
  // flips when the server row replaces the optimistic one — without
  // this React would re-use the same key and the spinner would never
  // retire.
  const [optimisticKey, setOptimisticKey] = useState<number>(0);
  // Single "now" stamp drives every note's relative age — refreshed on
  // a 60s tick so old notes visibly age inside the open tab. Mount-time
  // baseline avoids a 0→"0 seconds ago" flash on first render.
  const [now, setNow] = useState<number>(() => Date.now());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // 60-second aging tick — cheap enough to run forever; the cleanup
    // clears the interval so a re-mount doesn't double-arm the clock.
    const handle = setInterval(() => {
      if (!mountedRef.current) return;
      setNow(Date.now());
    }, RELATIVE_TICK_MS);
    return () => {
      clearInterval(handle);
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const payload = await apiFetch(`/api/alerts/${alertId}/comments`, {
          schema: AlertCommentList,
        });
        if (!active) return;
        setLoad({ kind: 'ready', items: payload.items });
      } catch {
        if (!active) return;
        // Soft-fail: render an inline empty state with a retry cue.
        // A 404 here would mean the alert vanished mid-mount (rare; the
        // parent detail island surfaces its own error card) — keep it
        // distinct from the composer so the operator isn't stranded.
        setLoad({ kind: 'error', message: 'Could not load update notes.' });
      }
    })();
    return () => {
      active = false;
    };
  }, [alertId]);

  async function handleSubmit() {
    if (composer.pending || !isAssignee) return;
    const trimmed = composer.body.trim();
    if (trimmed.length === 0) {
      setComposer((c) => ({ ...c, fieldError: 'Body cannot be empty.' }));
      return;
    }
    if (trimmed.length > MAX_BODY) {
      setComposer((c) => ({ ...c, fieldError: 'Body is too long.' }));
      return;
    }

    const optimisticId = `optimistic-${optimisticKey}`;
    setOptimisticKey((k) => k + 1);
    const optimisticRow: AlertCommentItem = {
      id: optimisticId,
      alertId,
      authorId: '__optimistic__',
      // Optimistic: no resolved author name from the server yet. The
      // reader sees a "Me" placeholder which is replaced when the real
      // row returns.
      authorName: 'Me',
      body: trimmed,
      createdAt: new Date().toISOString(),
    };
    setComposer({ body: '', pending: true, fieldError: null });
    // Server returns rows in ASC chronological order (oldest first,
    // newest last). Optimistic insert appends so the new note slides in
    // at the BOTTOM; on success the swap keeps the same position so the
    // DOM doesn't shuffle the row's neighbors.
    setLoad((prev) => {
      const items = prev.kind === 'ready' ? [...prev.items, optimisticRow] : [optimisticRow];
      return { kind: 'ready', items };
    });

    try {
      const raw = await apiFetch<unknown>(`/api/alerts/${alertId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: trimmed }),
      });
      // Validate the wire shape contractually so a server drift surfaces
      // here (ZodError) rather than as an undefined field downstream. The
      // POST response is a single AlertCommentItem — distinct from the
      // GET list envelope.
      const createdRow = AlertCommentItemSchema.parse(raw);
      if (!mountedRef.current) return;
      setLoad((prev) => {
        const items =
          prev.kind === 'ready'
            ? prev.items.map((it) => (it.id === optimisticId ? createdRow : it))
            : [createdRow];
        return { kind: 'ready', items };
      });
      toast.success('Update note posted.');
      onChanged?.();
    } catch (err: unknown) {
      // First, try a useful inline message — apiFetch attaches the
      // JSON body to `cause`. A 400 envelope is `{ errors: { body: '…' } }`,
      // a 403 is `{ error: 'not_assignee' }`. Anything else gets a toast.
      let inline: string | null = null;
      let toastMsg = 'Could not post update note.';
      const cause = (err as { cause?: unknown })?.cause as
        | { errors?: Record<string, string>; error?: string }
        | undefined;
      if (cause?.errors?.body) {
        inline = cause.errors.body;
      } else if (cause?.error === 'not_assignee') {
        toastMsg = 'Only the assigned team member can post update notes.';
      }
      if (!mountedRef.current) return;
      setLoad((prev) => {
        const items =
          prev.kind === 'ready' ? prev.items.filter((it) => it.id !== optimisticId) : [];
        return { kind: 'ready', items };
      });
      setComposer((c) => ({ ...c, pending: false, fieldError: inline }));
      if (!inline) toast.error(toastMsg);
    } finally {
      if (mountedRef.current) {
        setComposer((c) => ({ ...c, pending: false }));
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl-Enter posts — common pattern in comment composers and
    // matches the same shortcut in /api/alerts/[id]/ticket assist buttons.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setComposer((c) => ({ ...c, body: e.target.value, fieldError: null }));
  }

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
          Update notes
        </CardDescription>
        <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
          <MessageSquarePlus className="size-4 text-brand-500" aria-hidden />
          Assignee thread
        </CardTitle>
        <CardDescription className="text-caption text-muted-foreground">
          Notes the assignee posts while working this CVE. Read-only for the rest of the team.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {load.kind === 'idle' ? (
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading notes…
          </div>
        ) : load.kind === 'error' ? (
          <output className="block text-body text-muted-foreground">{load.message}</output>
        ) : load.items.length === 0 ? (
          <p className="max-w-prose text-body text-muted-foreground">No notes yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {load.items.map((item) => {
              const isPending = item.id.startsWith('optimistic-');
              return (
                <li
                  key={item.id}
                  className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="flex size-7 items-center justify-center rounded-full bg-brand-500/15 font-mono text-caption uppercase text-brand-700 dark:text-brand-300"
                      >
                        {avatarInitials(authorLabel(item))}
                      </span>
                      <span className="text-body font-medium text-foreground">
                        {authorLabel(item)}
                      </span>
                      {isPending ? (
                        <Badge variant="secondary" className="font-mono text-caption">
                          Sending…
                        </Badge>
                      ) : null}
                    </div>
                    <span
                      className="font-mono text-caption text-muted-foreground"
                      title={item.createdAt}
                    >
                      {formatRelative(item.createdAt, now)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-body text-foreground">{item.body}</p>
                </li>
              );
            })}
          </ol>
        )}

        {isAssignee ? (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
            <label
              htmlFor="alert-comment-body"
              className="text-eyebrow uppercase tracking-wider text-muted-foreground"
            >
              Post an update note
            </label>
            <Textarea
              id="alert-comment-body"
              name="body"
              value={composer.body}
              placeholder="Where you are on this CVE, what you tried, what blocks you…"
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              disabled={composer.pending}
              aria-invalid={composer.fieldError != null}
              aria-describedby={composer.fieldError ? 'alert-comment-body-error' : undefined}
              rows={4}
              className="max-w-prose"
            />
            {composer.fieldError ? (
              <p
                id="alert-comment-body-error"
                role="alert"
                className="text-caption font-medium text-destructive"
              >
                {composer.fieldError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-caption text-muted-foreground">
                {composer.body.trim().length} / {MAX_BODY}
                <span className="ml-2 hidden text-caption text-muted-foreground md:inline">
                  ⌘/Ctrl-Enter to send
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSubmit()}
                disabled={composer.pending || composer.body.trim().length === 0}
                aria-disabled={composer.pending || composer.body.trim().length === 0}
                className="min-h-11 md:min-h-0"
              >
                {composer.pending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Posting…
                  </>
                ) : (
                  <>
                    <Send className="size-4" aria-hidden />
                    Post note
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <p className="max-w-prose text-body text-muted-foreground">
            Only the assignee can post update notes. Switch the assignee on the card above to take
            over the thread.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
