// @polsia:user-owned — Team roster list. Fetches /api/team/memberships, renders
// an email / role / status / date table. Admin actions (role select, remove)
// are rendered inline for User.role==='admin' callers only (useIsAdmin gate).
// Pending invites get a Status badge and no admin actions — the role-select
// PATCH targets the Membership table, which doesn't have an invited row.

'use client';

import { Loader2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api-client';
import { useIsAdmin } from '@/lib/auth-client';
import {
  type MembershipItem as MembershipItemType,
  MembershipList,
  ROLE_LABELS,
} from '@/lib/contracts/team';
import { TeamRemoveMemberButton } from './remove-button';
import { TeamMemberRoleSelect } from './role-select';

function formatDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function roleBadgeVariant(role: MembershipItemType['role']): 'default' | 'secondary' | 'outline' {
  if (role === 'admin') return 'default';
  if (role === 'member') return 'secondary';
  return 'outline';
}

function statusBadgeVariant(status: MembershipItemType['status']): 'default' | 'secondary' {
  return status === 'active' ? 'default' : 'secondary';
}

function statusLabel(status: MembershipItemType['status']): string {
  return status === 'active' ? 'Active' : 'Invited';
}

// Cross-island invalidation: TeamInviteForm and TeamAssignForm dispatch this
// after a successful POST so the roster refetches without a server-component
// rebuild. Listening on `window` keeps both islands independent.
const INVALIDATE_EVENT = 'team:invalidate';

export function TeamRosterTable() {
  const [items, setItems] = useState<MembershipItemType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = useIsAdmin();

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/team/memberships', { schema: MembershipList });
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const handler = (): void => {
      void reload();
    };
    window.addEventListener(INVALIDATE_EVENT, handler);
    return () => window.removeEventListener(INVALIDATE_EVENT, handler);
  }, [reload]);

  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading members…
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {error ? (
        <p className="text-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Joined / Invited</TableHead>
              <TableHead className="w-[6rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                    <Users className="size-4" aria-hidden />
                    No teammates yet — invite or assign below.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={`${item.status}-${item.id}`}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">
                        {item.name ??
                          item.email ??
                          (item.userId ? `User ${item.userId.slice(0, 8)}` : 'Pending invite')}
                      </span>
                      <span className="font-mono text-caption text-muted-foreground">
                        {item.email ?? '—'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {isAdmin && item.status === 'active' ? (
                      <TeamMemberRoleSelect item={item} onChanged={reload} />
                    ) : (
                      <Badge variant={roleBadgeVariant(item.role)}>{ROLE_LABELS[item.role]}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(item.status)}>
                      {statusLabel(item.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden font-mono text-caption text-muted-foreground sm:table-cell">
                    {item.status === 'active'
                      ? formatDate(item.joinedAt ?? item.createdAt)
                      : formatDate(item.invitedAt ?? item.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {isAdmin && item.status === 'active' ? (
                      <TeamRemoveMemberButton item={item} onRemoved={reload} />
                    ) : (
                      <span className="text-caption text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Re-exported for invite-form / assign-form to dispatch on success.
export const TEAM_INVALIDATE_EVENT = INVALIDATE_EVENT;
