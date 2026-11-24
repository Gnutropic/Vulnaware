// @polsia:user-owned — Per-row revoke confirmation. Calls DELETE
// /api/v1/keys/{id} via apiFetch, then triggers the parent's onRevoked
// callback to reload the table.

'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function RevokeButton({ id, onRevoked }: { id: string; onRevoked?: () => void }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function revoke() {
    try {
      setSubmitting(true);
      const response = await fetch(`/api/v1/keys/${id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const reason =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error?: unknown }).error)
            : `revoke failed (${response.status})`;
        toast.error(reason);
        return;
      }
      toast.success('API key revoked');
      setOpen(false);
      onRevoked?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label="Revoke API key"
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke this API key?</DialogTitle>
          <DialogDescription>
            Integrations using this key will start receiving 401s immediately. The action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={revoke} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Revoking…
              </>
            ) : (
              <>Revoke key</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
