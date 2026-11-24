// @polsia:user-owned — Inline reason-prompt dialog for the /alerts page's
// "Mark false positive" row action and the bulk action bar's
// "Mark false positive…"). One dialog serves both the per-row gesture
// (one row, one reason) and the bulk gesture (N rows, one shared
// reason) — both call sites pass the same onSubmit(reason) callback.
//
// Why a dedicated dialog rather than reusing a global dialog primitive:
//   - Both the per-row and bulk gestures live below the page-level
//     dialog/menu layer (the page uses <Dialog> + a sticky bar with
//     multiple CTAs), so a local dialog here stays a self-contained
//     leaf in the component tree.
//   - The dialog is PRESENTATIONAL — it never imports apiFetch or
//     @/lib/db. The page owns the open state, the POST, and the
//     optimistic flip; the dialog just collects the reason.
//
// Server validation mirrors the client cap: zod's
// `AlertFalsePositiveBody` enforces `min(1).max(500)` with the
// `.trim()` modal, so a textarea that posts whitespace-only or empty
// text 400s on the route. The textarea carries `maxLength={500}` so
// the browser also caps the input at the same boundary so a paste
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

interface AlertsFalsePositiveDialogProps {
  // The dialog is fully controlled — the page owns the open state so
  // it can layer the dialog over the row action / bulk bar without a
  // second open-state source of truth.
  open: boolean;
  onOpenChange: (next: boolean) => void;
  // Fired when the operator clicks "Mark false positive" with a
  // non-empty, ≤500-char reason. The page owns the actual POST +
  // optimistic flip.
  onSubmit: (reason: string) => void | Promise<void>;
  // True while the page's POST is in flight — disables the submit
  // button + the Cancel button so a fast double-click can't fire a
  // second fan-out and the operator can't dismiss mid-flight.
  submitting: boolean;
  // Optional label sitting above the reason title — distinguishes
  // "False-positive note for this alert" (per-row) from "False-
  // positive note for N selected alerts" (bulk) without forcing the
  // page to compose the title differently per gesture.
  targetLabel: string;
}

export function AlertsFalsePositiveDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  targetLabel,
}: AlertsFalsePositiveDialogProps) {
  // Local state for the textarea — reset every time the dialog opens
  // so a stale reason from a prior dialog-open cycle doesn't leak.
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const trimmed = reason.trim();
  const canSubmit = !submitting && trimmed.length > 0 && trimmed.length <= MAX_REASON_CHARS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark false positive — {targetLabel}</DialogTitle>
          <DialogDescription>
            Note why this alert is a false positive. The reason shows in the row chip and the CSV
            export. 1–{MAX_REASON_CHARS} characters; whitespace-only reasons are rejected
            server-side.
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
          <Label htmlFor="false-positive-reason" className="text-eyebrow text-muted-foreground">
            Reason
          </Label>
          <Textarea
            id="false-positive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. scanner mis-flagged TLS 1.0 on a static site behind a WAF"
            maxLength={MAX_REASON_CHARS}
            autoFocus
            disabled={submitting}
            rows={4}
            data-testid="false-positive-reason-input"
          />
          <p className="text-caption text-muted-foreground">
            {trimmed.length}/{MAX_REASON_CHARS} characters
          </p>
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="false-positive-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="false-positive-submit">
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Marking…
                </>
              ) : (
                'Mark false positive'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
