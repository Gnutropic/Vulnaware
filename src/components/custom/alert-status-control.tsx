// @polsia:user-owned — Shared status control for alert detail and list rows.

'use client';

import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import {
  type AlertDetail,
  AlertStatus,
  type AlertStatusMutationResponse,
  AlertStatusMutationResponse as AlertStatusMutationResponseSchema,
} from '@/lib/contracts/alerts';

export const ALERT_STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'false_positive', label: 'False positive' },
] as const satisfies ReadonlyArray<{ value: AlertDetail['status']; label: string }>;

interface AlertStatusControlProps {
  alertId: string;
  status: AlertDetail['status'];
  onSaved: (saved: AlertStatusMutationResponse) => void;
}

export function AlertStatusControl({ alertId, status, onSaved }: AlertStatusControlProps) {
  const id = useId();
  const statusSelectId = `alert-status-select-${id}`;
  const reasonId = `alert-status-reason-${id}`;
  const reasonHelpId = `alert-status-reason-help-${id}`;
  const noteId = `alert-status-note-${id}`;
  const [pendingStatus, setPendingStatus] = useState<AlertDetail['status'] | null>(null);
  const [detailText, setDetailText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  async function saveStatus(
    nextStatus: AlertDetail['status'],
    text = detailText.trim(),
  ): Promise<void> {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);

    const body =
      nextStatus === 'false_positive'
        ? { status: nextStatus, reason: text }
        : nextStatus === 'resolved'
          ? { status: nextStatus, ...(text ? { note: text } : {}) }
          : { status: nextStatus };

    try {
      const saved = await apiFetch(`/api/alerts/${alertId}/status`, {
        method: 'POST',
        body: JSON.stringify(body),
        schema: AlertStatusMutationResponseSchema,
      });
      onSaved(saved);
      setPendingStatus(null);
      setDetailText('');
      toast.success(
        `Alert status changed to ${ALERT_STATUS_OPTIONS.find((option) => option.value === saved.status)?.label ?? saved.status}.`,
      );
    } catch {
      const currentLabel =
        ALERT_STATUS_OPTIONS.find((option) => option.value === status)?.label ??
        'the current status';
      setError(
        `Could not confirm the status change. The displayed status remains ${currentLabel}. Refresh to verify, then try again.`,
      );
      toast.error('Could not confirm the alert status change.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function selectStatus(value: string): void {
    const parsed = AlertStatus.safeParse(value);
    if (!parsed.success || parsed.data === status || savingRef.current) return;

    setError(null);
    setDetailText('');
    if (parsed.data === 'false_positive' || parsed.data === 'resolved') {
      setPendingStatus(parsed.data);
      return;
    }
    setPendingStatus(null);
    void saveStatus(parsed.data, '');
  }

  const needsReason = pendingStatus === 'false_positive';
  const needsNote = pendingStatus === 'resolved';
  const trimmedText = detailText.trim();

  return (
    <div className="min-w-36 space-y-2">
      <Label htmlFor={statusSelectId} className="text-caption text-muted-foreground">
        Status
      </Label>
      <Select value={status} onValueChange={selectStatus} disabled={saving}>
        <SelectTrigger
          id={statusSelectId}
          aria-label={`Alert status for ${alertId}`}
          aria-busy={saving}
          data-testid="alert-status"
          className="font-medium"
        >
          <SelectValue placeholder="Choose status" />
        </SelectTrigger>
        <SelectContent align="start">
          {ALERT_STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {pendingStatus ? (
        <form
          className="w-full space-y-2 rounded-md border bg-muted/30 p-3 sm:min-w-72"
          onSubmit={(event) => {
            event.preventDefault();
            void saveStatus(pendingStatus);
          }}
        >
          {needsReason ? (
            <>
              <Label htmlFor={reasonId}>Reason (required)</Label>
              <Textarea
                id={reasonId}
                value={detailText}
                onChange={(event) => setDetailText(event.target.value)}
                placeholder="Explain why this alert is a false positive"
                maxLength={500}
                rows={3}
                disabled={saving}
                aria-describedby={reasonHelpId}
              />
              <p id={reasonHelpId} className="text-caption text-muted-foreground">
                {trimmedText.length}/500 characters. Enter a nonblank reason.
              </p>
            </>
          ) : needsNote ? (
            <>
              <Label htmlFor={noteId}>Close note (optional)</Label>
              <Textarea
                id={noteId}
                value={detailText}
                onChange={(event) => setDetailText(event.target.value)}
                placeholder="Add a short resolution note"
                maxLength={500}
                rows={3}
                disabled={saving}
              />
            </>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingStatus(null);
                setDetailText('');
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                saving || (needsReason && (trimmedText.length === 0 || trimmedText.length > 500))
              }
            >
              {saving ? 'Saving…' : 'Save status'}
            </Button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p
          className="max-w-sm break-words text-sm text-destructive"
          role="alert"
          data-testid="alert-status-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
