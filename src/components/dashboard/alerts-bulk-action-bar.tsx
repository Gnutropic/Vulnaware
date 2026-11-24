// @polsia:user-owned — Sticky bulk-resolve action bar for the /alerts
// page. Mounts above the table/cards when at least one row is selected
// ("N selected", a "Mark selected resolved" CTA, an indicator strip of
// per-row outcomes, a "Clear" affordance). Presentational ONLY — never
// touches a fetch or DB. The page owns the URL state, the working set,
// the bulk-resolve handler, and the per-row outcomes map; this island
// receives them as props and emits user gestures back up.
//
// Why a comp boundary: the page composes the per-row checkboxes, the
// header checkbox, the URL writer, and the resolve fan-out in one place;
// giving this bar its own mount keeps those concerns separate from the
// rendering. The bar always receives `pending` while its handler is
// in-flight so a fast double-click can't double-fire a fan-out.

'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import type { SnoozeDuration } from '@/lib/contracts/alerts';
import type { MemberOption } from '@/lib/contracts/team';

export type BulkRowOutcome = 'pending' | 'ok' | 'err';

// Picker options: the four snooze windows the bulk-bar accepts. Each
// label is the human-readable shorthand that pairs with the matching
// `SnoozeDuration` literal — the route stamps `now + WINDOW_MS[label]`
// so the operator sees a calibrated countdown per pick.
//
// Order matches the picker layout (1d → 3d → 7d → 30d) AND the route's
// `WINDOW_MS` table ordering, so a future widening of either surface
// cascades without a re-sort. Literal type is the shared `SnoozeDuration`
// so the helper's bulk input and the page's submitBulkSnooze signature
// accept the array's element type without an extra widening.
const SNOOZE_OPTIONS: ReadonlyArray<{ key: SnoozeDuration; label: string }> = [
  { key: '1d', label: 'Snooze 1d' },
  { key: '3d', label: 'Snooze 3d' },
  { key: '7d', label: 'Snooze 7d' },
  { key: '30d', label: 'Snooze 30d' },
];

interface AlertsBulkActionBarProps {
  // Working-set size — drives the "N selected" caption and the disabled
  // state of the resolve CTA. Match against the page's `data.items`
  // so the bar always reflects the current visible-row set.
  selectionCount: number;
  // Per-row outcome map keyed by alert id. `pending` is set for the
  // in-flight rows (one each between fan-out start and completion); `ok`
  // / `err` are stamped by the page handler as the Promise.allSettled
  // resolves. Rows missing from the map render as no chip — the
  // default 'idle' for un-resolved rows in the working set.
  results: Map<string, BulkRowOutcome>;
  // True while the page's bulk fan-out is in flight; flips true at
  // fan-out start, false at allSettled. Disables the resolve CTA so a
  // rapid double-click never queues a second fan-out.
  pending: boolean;
  // Fired when the operator clicks "Mark selected resolved". The page
  // owns the actual fetch fan-out; this bar never imports anything
  // from `@/lib/api-client` or `@/lib/db`.
  onResolve: () => void;
  // Fired when the operator clicks "Reopen selected". Inverse of
  // `onResolve` — flips selected resolved rows back to 'open'. The
  // page-side handler pre-filters to `status === 'resolved'` and
  // silently skips already-open ids (mirrors the route's idempotent-
  // already-open branch, where the server returns the same envelope
  // without an UPDATE). Both CTAs share the same `pending` gate so a
  // stale double-click across the two never queues a second fan-out.
  onReopenSelected: () => void;
  // Fires when the operator clicks "Mark false positive…". The page
  // owns the dialog's open state and the POST — this island just
  // emits the intent. Trailing ellipsis signals the operator that
  // the click opens a reason-prompt dialog. The bulk gesture applies
  // a single shared reason to N selected rows; per-row prompts would
  // be a UX anti-pattern with the 1–500-char reason body. The
  // gesture sits between Reopen and the Snooze popover in the visual
  // order so the "suppress" branch reads next to the snooze-window
  // affordance it precedes.
  onMarkFalsePositive: () => void;
  // Fires when the operator picks a snooze option from the popover.
  // Server-stamps the window end (`now + WINDOW_MS[duration]`) on
  // every selected row in a single prisma.$transaction via POST
  // /api/alerts/snooze-batch. Re-applying same literal refreshes the
  // window — the bulk route is idempotent on prior `snoozedUntil`
  // values. The literal accepts 1d / 3d / 7d / 30d so the popover's
  // four options flow through the shared `SnoozeDuration` enum end-
  // to-end. The single `pending` gate disables the trigger while a
  // fan-out is in flight and the popover closes before the option
  // fires so a re-click can't queue a second fan-out mid-flight.
  onSnooze: (duration: SnoozeDuration) => void;
  // Fires when the operator types a future ISO date (via the
  // `<input type="date">` in the popover's custom-date section) and
  // clicks the Apply button. Server echoes the supplied ISO verbatim
  // so the on-row countdown reads the moment the operator chose.
  // `null` is reserved for the explicit "Un-snooze" posture the
  // single-id SnoozeCard already emits (NOT surfaced today on the
  // bulk bar — the custom-date arm flows through the input picker
  // only). The popover closes BEFORE the value is emitted so a
  // re-click after enter can't queue a second fan-out, and the
  // `pending` prop gates the underlying input + Apply button so a
  // stale in-flight click can't smuggle in a second target.
  onSnoozeUntil: (until: string) => void;
  // Fires when the operator clicks "Mark remediated". Server-stamps
  // `remediatedAt = now()` AND `remediatedByEmail = callerEmail` per
  // row, one UPDATE per id, via POST /api/alerts/remediate-batch.
  // The bulk route is OWNER-gated per id (mirrors the single-id
  // `[id]/remediate` PATCH) and short-circuits already-remediated
  // rows on the helper's pre-filter — both branches surface as
  // 'err' on the outcome map. Sits between the Snooze popover and
  // Resolve in the visual order so the "I acted on this" branch
  // reads next to the snooze-window affordance it supplements.
  onRemediate: () => void;
  // Fires when the operator clicks "Take ownership". Server-stamps
  // `Alert.ownerId = callerWorkspaceMember.id` per row, ONE UPDATE
  // per id, via POST /api/alerts/ownership-batch. Idempotent on
  // already-owned rows — the route surfaces those via the
  // `conflicts[]` envelope arm (HTTP 200, NOT 409) and the helper
  // pre-filters them so they never reach the wire. Sits between
  // Remediate and Resolve in the visual order so the "claim
  // triage" branch reads next to the "I acted on this" branch it
  // precedes; the trailing Resolve is gated separately so the
  // claim gesture doesn't accidentally land the row in `resolved`.
  onTakeOwnership: () => void;
  // Fires when the operator picks a member in the bulk "Assign
  // owner…" popover. Server-stamps `Alert.ownerId = picked` on
  // every selected row in a single `prisma.$transaction` via
  // POST /api/alerts/assign-owner-batch. Idempotent on
  // already-owned rows (re-stamping the same FK is the
  // explicit idempotent-refresh branch; the route echoes the
  // same row in `results[]` so the helper still paints 'ok').
  // The picker mirrors the /api/team/members roster shape so
  // the page's already-fetched roster feeds back into the
  // popover without a second round trip. The callback only
  // emits the bare `ownerId` — the bar is presentational; the
  // page resolves the display name from its already-fetched
  // roster (mirrors how the single-id `/alerts/[id]` picker
  // resolves names from a separate peer-read).
  onAssignOwner: (ownerId: string) => void;
  // Fires when the operator clicks "Resolve" inside the bulk
  // "Resolve selected" popover, with the typed note (or '' for
  // a blank note). Server-stamps `status: 'resolved'` plus the
  // close-stamp trio on every selected row in a single
  // prisma.$transaction via POST /api/alerts/resolve-batch.
  // When `note.trim()` is non-blank the route ALSO inserts one
  // `AlertNote.create` row per resolved alert (a 2000-char
  // cap aligned with the AlertNote body schema). The popover
  // closes BEFORE the value is emitted so a re-click after
  // resolve can't queue a second fan-out, and the `pending`
  // prop disables both the trigger and the popover's Resolve
  // button while a fan-out is in flight. The popover mirrors
  // the Assign-owner posture: local open state reset on every
  // emission, presentational textarea, no fetch / no DB read.
  onResolveSelected: (note: string) => void;
  // Roster snapshot fetched from /api/team/members — drives
  // the popover's option list. The page passes the
  // already-fetched roster so the bar mounts without a second
  // round trip; an empty array renders "no members yet…" (a
  // workspace with zero active members renders no options
  // rather than crashing the popover). The shape mirrors
  // /api/team/members exactly so the page's fetch resolves
  // through `MemberOptionList` without an extra widening.
  members: MemberOption[];
  // Fires when the operator clicks "Clear". Drops the working set so
  // the "Mark selected resolved" affordance + the per-row checkboxes
  // drop back to the unselected state.
  onClear: () => void;
}

export function AlertsBulkActionBar({
  selectionCount,
  results,
  pending,
  onResolve,
  onReopenSelected,
  onMarkFalsePositive,
  onSnooze,
  onSnoozeUntil,
  onRemediate,
  onTakeOwnership,
  onAssignOwner,
  onResolveSelected,
  members,
  onClear,
}: AlertsBulkActionBarProps) {
  // Local open state for the Snooze popover so an option click can
  // close the menu BEFORE the parent fan-out fires — a re-click after
  // pick can't queue a second fan-out mid-flight, and the popover
  // never lingers open across the in-flight spinner.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // Local open state for the Assign owner popover so a member pick
  // closes the menu BEFORE the page-level fan-out fires — a re-click
  // after pick can't queue a second fan-out mid-flight, and the
  // popover never lingers open across the in-flight spinner. Mirrors
  // the Snooze popover's posture bit-for-bit.
  const [assignOpen, setAssignOpen] = useState(false);
  // Local open state for the Resolve-selected popover so a "Resolve"
  // click closes the menu BEFORE the page-level fan-out fires — a
  // re-click after resolve can't queue a second fan-out mid-flight,
  // and the popover never lingers open across the in-flight
  // spinner. Mirrors the Assign-owner popover's posture bit-for-bit
  // (the Shovel/Resolve pair both lift the action into a popover
  // for the inline-note affordance).
  const [resolveBatchOpen, setResolveBatchOpen] = useState(false);
  // Local state for the Resolve-selected popover's `<Textarea>`.
  // Reset on every popover open so a freshly-mounted popover never
  // lingers on a stale string from the prior run; the textarea's
  // `maxLength={2000}` aligns with `AlertNoteCreateBody.body`'s
  // cap (NOT 500 like the bulk-resolve Dialog), matching the
  // /resolve-batch route's `note` body schema. Trimming is
  // delegated to the helper + route so a whitespace-only note
  // collapses to the bare `alert.update` arm at both layers.
  const [resolveBatchNote, setResolveBatchNote] = useState('');
  // Local state for the custom-date picker section's `<input
  // type="date">`. Reset on every option click so a fresh open of the
  // popover never lingers on the prior pick, and the popover's Apply
  // button is disabled until a value is typed AND the value parses
  // to a non-past moment (a past pick would 200-then-immediately-
  // surface in the list, so the UI gates it client-side; the route
  // does not 400 mirrors the single-id SnoozeCard posture).
  const [snoozeUntilInput, setSnoozeUntilInput] = useState('');
  const todayIso = new Date().toISOString().slice(0, 10);
  const snoozeUntilValid = snoozeUntilInput.length > 0 && snoozeUntilInput >= todayIso;
  if (selectionCount === 0) return null;
  // Stable order: present `results` keys first, then any selected ids
  // not yet seen (these are 'idle'). Match the page's effectiveQs-writer
  // contract by keying off `results` first so a finished indicator chip
  // is always visible to the user when the fan-out resolves.
  const ids = Array.from(results.keys());
  return (
    <output
      aria-label={`${selectionCount} alerts selected`}
      className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
    >
      <span className="flex flex-wrap items-center gap-3">
        <span className="text-caption font-medium text-foreground">
          {selectionCount} {selectionCount === 1 ? 'alert' : 'alerts'} selected
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {ids.map((id) => {
            const outcome = results.get(id) ?? 'idle';
            if (outcome === 'pending') {
              return (
                <Badge key={id} variant="outline" className="font-mono text-caption">
                  <Loader2 className="mr-1 size-3 animate-spin" aria-hidden /> {id}
                </Badge>
              );
            }
            if (outcome === 'ok') {
              return (
                <Badge
                  key={id}
                  variant="outline"
                  className="font-mono text-caption text-foreground"
                  data-testid={`bulk-indicator-${id}`}
                >
                  <CheckCircle2 className="mr-1 size-3 text-emerald-600" aria-hidden />
                  {id}
                </Badge>
              );
            }
            if (outcome === 'err') {
              return (
                <Badge
                  key={id}
                  variant="destructive"
                  className="font-mono text-caption"
                  data-testid={`bulk-indicator-${id}`}
                >
                  <XCircle className="mr-1 size-3" aria-hidden /> {id}
                </Badge>
              );
            }
            return null;
          })}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onClear}
          disabled={pending}
          aria-disabled={pending}
        >
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReopenSelected}
          disabled={pending}
          aria-disabled={pending}
          data-testid="bulk-reopen-cta"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Reopening…
            </>
          ) : (
            'Reopen selected'
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onMarkFalsePositive}
          disabled={pending}
          aria-disabled={pending}
          data-testid="bulk-false-positive-cta"
        >
          Mark false positive…
        </Button>
        <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-disabled={pending}
              data-testid="bulk-snooze-picker-cta"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Snoozing…
                </>
              ) : (
                'Snooze'
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="flex w-56 flex-col gap-2 p-2"
            data-testid="bulk-snooze-picker-content"
          >
            {SNOOZE_OPTIONS.map((option) => (
              <Button
                key={option.key}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSnoozeOpen(false);
                  setSnoozeUntilInput('');
                  onSnooze(option.key);
                }}
                disabled={pending}
                aria-disabled={pending}
                data-testid={`bulk-snooze-pick-${option.key}`}
                className="justify-start"
              >
                {option.label}
              </Button>
            ))}
            {/*
              Custom-date arm — third section inside the same popover.
              Visual rhythm: thin divider-style eyebrow label above,
              `<input type="date">` below, Apply button on the right.
              The input's `min={todayIso}` blocks past-date selection
              at the browser level (matches the route's "past ISO is
              accepted (no 400) but lists immediately on next refresh"
              posture so the UI is the gate, not the route).
            */}
            <div className="border-t border-border pt-2">
              <label
                htmlFor="bulk-snooze-until-input"
                className="block text-eyebrow uppercase tracking-wider text-muted-foreground"
              >
                Custom date
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="bulk-snooze-until-input"
                  type="date"
                  min={todayIso}
                  value={snoozeUntilInput}
                  onChange={(e) => setSnoozeUntilInput(e.target.value)}
                  disabled={pending}
                  aria-label="Snooze selected alerts until this date"
                  data-testid="bulk-snooze-until-input"
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() => {
                    setSnoozeOpen(false);
                    setSnoozeUntilInput('');
                    onSnoozeUntil(snoozeUntilInput);
                  }}
                  disabled={pending || !snoozeUntilValid}
                  aria-disabled={pending || !snoozeUntilValid}
                  data-testid="bulk-snooze-until-apply"
                >
                  Snooze until…
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRemediate}
          disabled={pending}
          aria-disabled={pending}
          data-testid="bulk-remediate-cta"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Remediating…
            </>
          ) : (
            'Mark remediated'
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onTakeOwnership}
          disabled={pending}
          aria-disabled={pending}
          data-testid="bulk-take-ownership-cta"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Taking ownership…
            </>
          ) : (
            'Take ownership'
          )}
        </Button>
        {/*
          Assign-owner popover — sister to the Snooze popover. The
          trigger flips between the active label ("Assigning…") and
          the resting label ("Assign owner…"). A pick closes the
          popover BEFORE the page fan-out fires so a re-click can't
          queue a second fan-out mid-flight, and the `pending` prop
          disables the trigger while the fan-out runs.
          Roster options render from the page-supplied `members`
          list (no fetch inside the bar). The `name ?? email`
          fallback mirrors /api/team/members' `name: u?.name ??
          row.email` posture so a roster option with a missing
          name still has a renderable label.
        */}
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-disabled={pending}
              data-testid="bulk-assign-owner-cta"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Assigning…
                </>
              ) : (
                'Assign owner…'
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="flex w-64 flex-col gap-1 p-2"
            data-testid="bulk-assign-owner-content"
          >
            {members.length === 0 ? (
              <p className="px-2 py-1 text-caption text-muted-foreground">No members yet…</p>
            ) : (
              members.map((member) => (
                <Button
                  key={member.id}
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAssignOpen(false);
                    onAssignOwner(member.id);
                  }}
                  disabled={pending}
                  aria-disabled={pending}
                  data-testid={`bulk-assign-owner-pick-${member.id}`}
                  className="justify-start"
                >
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="font-medium">{member.name || member.email}</span>
                    {member.name ? (
                      <span className="text-caption text-muted-foreground">{member.email}</span>
                    ) : null}
                  </span>
                </Button>
              ))
            )}
          </PopoverContent>
        </Popover>
        {/*
          Resolve-selected popover — sister to the Snooze +
          Assign-owner popovers. The popover surfaces an OPTIONAL
          shared resolution note (Textarea) and a "Resolve" button;
          clicking Resolve POSTs /api/alerts/resolve-batch with
          the trimmed note body. The trigger flips between the
          active label ("Resolving…") and the resting label
          ("Resolve selected"). The popover closes BEFORE the page
          fan-out fires so a re-click after resolve can't queue a
          second fan-out mid-flight; the trigger + the
          popover's Resolve button are both gated by `pending`.
          The textarea's `maxLength={2000}` aligns with
          `AlertNoteCreateBody.body`'s cap (NOT 500 like the
          bulk-resolve Dialog) since the bulk popover writes one
          AlertNote row per resolved alert when a non-blank note
          is supplied.
        */}
        <Popover
          open={resolveBatchOpen}
          onOpenChange={(next) => {
            setResolveBatchOpen(next);
            if (next) {
              // Reset on every open so a freshly-mounted popover
              // never lingers on a stale note from the prior run.
              setResolveBatchNote('');
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-disabled={pending}
              data-testid="bulk-resolve-batch-cta"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Resolving…
                </>
              ) : (
                'Resolve selected'
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex w-80 flex-col gap-2 p-3"
            data-testid="bulk-resolve-batch-content"
          >
            <label
              htmlFor="bulk-resolve-batch-note"
              className="text-eyebrow uppercase tracking-wider text-muted-foreground"
            >
              Resolution note (optional)
            </label>
            <Textarea
              id="bulk-resolve-batch-note"
              value={resolveBatchNote}
              onChange={(e) => setResolveBatchNote(e.target.value)}
              maxLength={2000}
              disabled={pending}
              placeholder="Add a note that will be recorded on every selected alert."
              rows={4}
              data-testid="bulk-resolve-batch-note"
            />
            <p className="text-caption text-muted-foreground">
              Leaving the note blank still resolves the alerts — no empty breadcrumb is recorded.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setResolveBatchOpen(false);
                onResolveSelected(resolveBatchNote);
              }}
              disabled={pending}
              aria-disabled={pending}
              data-testid="bulk-resolve-batch-submit"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Resolving…
                </>
              ) : (
                'Resolve'
              )}
            </Button>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          size="sm"
          onClick={onResolve}
          disabled={pending}
          aria-disabled={pending}
          data-testid="bulk-resolve-cta"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Resolving…
            </>
          ) : (
            'Mark selected resolved'
          )}
        </Button>
      </span>
    </output>
  );
}
