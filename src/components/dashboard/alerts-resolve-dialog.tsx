// @polsia:user-owned — Inline note-prompt dialog for the /alerts page's
// bulk "Resolve selected" gesture. Sister to
// `alerts-reopen-dialog.tsx` — same page-side state pattern, same
// presentational discipline. The resolve route accepts an OPTIONAL
// note (parity with the reopen route's `reason`), so this dialog
// mirrors the reopen dialog's shape but with the `note` named-arg
// rather than `reason`.
//
// Why a dedicated dialog rather than reusing a global dialog primitive:
//   - The page uses <Dialog> + a sticky bulk bar with multiple CTAs,
//     so a local dialog here stays a self-contained leaf in the
//     component tree.
//   - The dialog is PRESENTATIONAL — it never imports apiFetch or
//     @/lib/db. The page owns the open state, the POST, and the
//     optimistic flip; the dialog just collects the (optional) note.
//
// Server validation mirrors the client cap: zod's `AlertResolveBody`
// enforces `max(500)` with the `.trim()` modal, so a textarea that
// posts whitespace-only or empty text stamps `closingNote: NULL`
// via the `{}` body. The textarea carries `maxLength={500}` so the
// browser also caps the input at the same boundary so a paste
// storm never produces a 500-char overflow message.

'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MAX_NOTE_CHARS = 500;

interface AlertsResolveDialogProps {
  // The dialog is fully controlled — the page owns the open state so
  // it can layer the dialog over the bulk action bar without a
  // second open-state source of truth.
  open: boolean;
  onOpenChange: (next: boolean) => void;
  // Fired when the operator clicks "Resolve" with a (possibly empty)
  // note. The page owns the actual fan-out + optimistic flip.
  // Empty-or-whitespace-only `note` arrives here as an empty string —
  // the helper trims that branch to `{}` so the route stamps NULL on
  // every row.
  onSubmit: (note: string) => void | Promise<void>;
  // True while the page's fan-out is in flight — disables the
  // submit + cancel buttons so a fast double-click can't fire a
  // second fan-out and the operator can't dismiss mid-flight.
  submitting: boolean;
  // Bulk-CTA label — "12 selected alerts" vs "this alert". Today
  // only the bulk branch flows through this dialog (the single-
  // row resolve path is inline on the detail card); the prop stays
  // for parity with the reopen dialog nonetheless.
  targetLabel: string;
}

export function AlertsResolveDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  targetLabel,
}: AlertsResolveDialogProps) {
  // Local state for the textarea — reset every time the dialog
  // opens so a stale note from a prior dialog-open cycle doesn't
  // leak.
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const trimmed = note.trim();
  const length = trimmed.length;
  // The resolve page-side flow POSTs `{}` on the blank branch, so
  // we don't gate on `length > 0`; we gate on the VARCHAR(500)
  // cap so a paste storm can't lift the input past the route's
  // zod `.max(500)` ceiling and round-trip into a 400.
  const canSubmit = !submitting && length <= MAX_NOTE_CHARS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve — {targetLabel}</DialogTitle>
          <DialogDescription>
            Add an optional shared note to stamp onto every resolved alert. A blank note stamps NULL
            on every row — the operator only needs to write a note if the bulk flip is part of a
            wider review (e.g. closing after a compliance audit).
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            void onSubmit(trimmed);
          }}
          className="flex flex-col gap-2"
        >
          <Label htmlFor="resolve-bulk-note" className="text-eyebrow text-muted-foreground">
            Note (optional)
          </Label>
          <Textarea
            id="resolve-bulk-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. closing as part of v2 patch baseline rollout"
            maxLength={MAX_NOTE_CHARS}
            autoFocus
            disabled={submitting}
            rows={4}
            data-testid="resolve-bulk-note-input"
          />
          <p className="text-caption text-muted-foreground">
            {length}/{MAX_NOTE_CHARS} characters
          </p>
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="resolve-bulk-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="resolve-bulk-submit">
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Resolving…
                </>
              ) : (
                'Resolve'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
