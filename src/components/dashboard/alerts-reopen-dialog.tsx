// @polsia:user-owned — Inline reason-prompt dialog for the /alerts
// page's bulk "Reopen selected..." gesture. Sister to
// `alerts-false-positive-dialog.tsx` — same page-side state pattern,
// same presentational discipline. The reopen route accepts an
// OPTIONAL reason (parity with the resolve route's `note`), so this
// dialog mirrors the FP dialog's shape but with the submit gate
// loosened: an empty reason is valid on the reopen path (just like
// a blank resolve), so the dialog's submit button is enabled
// whenever the input is non-overflow (no `.min(1)`) and treats
// empty as "post `{}` body, route stamps NULL".
//
// Why a dedicated dialog rather than reusing a global dialog primitive:
//   - The page uses <Dialog> + a sticky bulk bar with multiple CTAs,
//     so a local dialog here stays a self-contained leaf in the
//     component tree.
//   - The dialog is PRESENTATIONAL — it never imports apiFetch or
//     @/lib/db. The page owns the open state, the POST, and the
//     optimistic flip; the dialog just collects the (optional)
//     reason.
//
// Server validation mirrors the client cap: zod's `AlertReopenBody`
// enforces `max(500)` with the `.trim()` modal, so a textarea that
// posts whitespace-only or empty text stamps `reopenReason: NULL`
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

const MAX_REASON_CHARS = 500;

interface AlertsReopenDialogProps {
  // The dialog is fully controlled — the page owns the open state so
  // it can layer the dialog over the bulk action bar without a
  // second open-state source of truth.
  open: boolean;
  onOpenChange: (next: boolean) => void;
  // Fired when the operator clicks "Reopen" with a (possibly empty)
  // reason. The page owns the actual fan-out + optimistic flip.
  // Empty-or-whitespace-only `reason` arrives here as an empty
  // string — the helper trims that branch to `{}` so the route
  // stamps NULL on every row.
  onSubmit: (reason: string) => void | Promise<void>;
  // True while the page's fan-out is in flight — disables the
  // submit + cancel buttons so a fast double-click can't fire a
  // second fan-out and the operator can't dismiss mid-flight.
  submitting: boolean;
  // Bulk-CTA label — "12 selected alerts" vs "this alert". Today
  // only the bulk branch flows through this dialog (the single-
  // row reopen path is inline on the detail card); the prop stays
  // for parity with the FP dialog nonetheless.
  targetLabel: string;
}

export function AlertsReopenDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  targetLabel,
}: AlertsReopenDialogProps) {
  // Local state for the textarea — reset every time the dialog
  // opens so a stale reason from a prior dialog-open cycle
  // doesn't leak.
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const trimmed = reason.trim();
  const length = trimmed.length;
  // The reopen page-side flow POSTs `{}` on the blank branch, so
  // we don't gate on `length > 0`; we gate on the VARCHAR(500)
  // cap so a paste storm can't lift the input past the route's
  // zod `.max(500)` ceiling and round-trip into a 400.
  const canSubmit = !submitting && length <= MAX_REASON_CHARS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen — {targetLabel}</DialogTitle>
          <DialogDescription>
            Add an optional shared reason to stamp onto every reopened alert. A blank reason stamps
            NULL on every row — the operator only needs to write a note if the bulk flip is part of
            a wider review (e.g. re-triage after a config rollout).
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
          <Label htmlFor="reopen-bulk-reason" className="text-eyebrow text-muted-foreground">
            Reason (optional)
          </Label>
          <Textarea
            id="reopen-bulk-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. CVE re-triage after applying v2 patch baseline"
            maxLength={MAX_REASON_CHARS}
            autoFocus
            disabled={submitting}
            rows={4}
            data-testid="reopen-bulk-reason-input"
          />
          <p className="text-caption text-muted-foreground">
            {length}/{MAX_REASON_CHARS} characters
          </p>
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="reopen-bulk-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="reopen-bulk-submit">
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Reopening…
                </>
              ) : (
                'Reopen'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
