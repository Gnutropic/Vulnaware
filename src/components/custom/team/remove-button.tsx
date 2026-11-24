// @polsia:user-owned — Remove-member button. Confirms via window.confirm to
// avoid the cost of a dialog round-trip on a destructive action that the
// admin can re-issue with one click.

'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import type { MembershipItem as MembershipItemType } from '@/lib/contracts/team';

interface Props {
  item: MembershipItemType;
  onRemoved?: () => void;
}

export function TeamRemoveMemberButton({ item, onRemoved }: Props) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    const label = item.email ?? item.name ?? 'this member';
    if (!window.confirm(`Remove ${label} from this team?`)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/team/memberships/${item.id}`, { method: 'DELETE' });
      toast.success(`${label} removed from this team.`);
      onRemoved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not remove member.';
      if (msg.includes('409')) {
        toast.error('Cannot remove the last admin.');
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={busy}
      aria-label={`Remove ${item.email ?? 'member'}`}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="size-4 text-destructive" aria-hidden />
      )}
    </Button>
  );
}
