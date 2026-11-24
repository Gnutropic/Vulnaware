// @polsia:user-owned — Inline role select for a single member. Optimistically
// updates the row label, PATCHes /api/team/memberships/[id], and rolls back
// on a 403. Server errors surface via toast.

'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-client';
import {
  type MembershipItem as MembershipItemType,
  MembershipRoleUpdate,
  type MembershipRoleUpdateInput,
  ROLE_LABELS,
} from '@/lib/contracts/team';

interface Props {
  item: MembershipItemType;
  onChanged?: () => void;
}

export function TeamMemberRoleSelect({ item, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<MembershipItemType['role'] | null>(null);

  async function handleChange(nextRole: string) {
    if (busy) return;
    if (nextRole !== 'admin' && nextRole !== 'member' && nextRole !== 'viewer') return;
    if (nextRole === item.role) return;

    setBusy(true);
    setOptimistic(nextRole);
    try {
      const body: MembershipRoleUpdateInput = { role: nextRole };
      await apiFetch(`/api/team/memberships/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        schema: MembershipRoleUpdate,
      });
      toast.success(`Role updated to ${ROLE_LABELS[nextRole]}.`);
      setOptimistic(null);
      onChanged?.();
    } catch (err) {
      // Roll back optimistic UI on failure.
      setOptimistic(null);
      const msg = err instanceof Error ? err.message : 'Could not update role.';
      if (msg.includes('403')) {
        toast.error('You do not have permission to change this member.');
      } else if (msg.includes('409')) {
        toast.error('Cannot demote the last admin.');
      } else {
        toast.error(msg);
      }
      // Force a refresh so the server's view of role is re-rendered.
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const current = optimistic ?? item.role;
  return (
    <Select value={current} onValueChange={handleChange} disabled={busy}>
      <SelectTrigger className="h-8 w-[8.5rem] border-border/60 bg-background">
        <SelectValue>
          <Badge variant={variantFor(current)}>{ROLE_LABELS[current]}</Badge>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>
        <SelectItem value="member">{ROLE_LABELS.member}</SelectItem>
        <SelectItem value="viewer">{ROLE_LABELS.viewer}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function variantFor(role: MembershipItemType['role']): 'default' | 'secondary' | 'outline' {
  if (role === 'admin') return 'default';
  if (role === 'member') return 'secondary';
  return 'outline';
}
