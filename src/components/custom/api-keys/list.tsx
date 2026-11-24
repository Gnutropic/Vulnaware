// @polsia:user-owned — API keys list island. Renders the manager-side table,
// fetches via apiFetch + ApiKeyList contract, hands per-row revoke to
// <RevokeButton/>. `'use client'` — never imports server-only modules.

'use client';

import { KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { RevokeButton } from '@/components/custom/api-keys/revoke-button';
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
import { type ApiKeyItem as ApiKeyItemType, ApiKeyList } from '@/lib/contracts/api-key';

function scopeLabel(item: ApiKeyItemType): string {
  if (item.scopeKind === 'team') return 'Team-wide';
  return item.scanId ? `Scan ${item.scanId}` : 'Scan';
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  // value is ISO-8601. Render just the date for compactness; full timestamp
  // would push other columns off the page.
  return new Date(value).toISOString().slice(0, 10);
}

export function ApiKeyListView() {
  const [items, setItems] = useState<ApiKeyItemType[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await apiFetch('/api/v1/keys', { schema: ApiKeyList });
      setItems(list.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keys');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (items === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading keys…
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
              <TableHead>Name</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[6rem] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex items-center gap-2 px-2 py-6 text-caption text-muted-foreground">
                    <KeyRound className="size-4" aria-hidden />
                    No API keys yet — create one to issue a token for an integration.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{item.team.name}</Badge>
                  </TableCell>
                  <TableCell>
                    {item.scopeKind === 'team' ? (
                      <Badge variant="secondary">{scopeLabel(item)}</Badge>
                    ) : (
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground">
                        {scopeLabel(item)}
                      </code>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatDate(item.createdAt)}
                  </TableCell>
                  <TableCell className="font-mono text-caption text-muted-foreground">
                    {formatDate(item.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    {item.revokedAt ? (
                      <Badge variant="destructive">Revoked</Badge>
                    ) : (
                      <Badge variant="outline">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.revokedAt ? (
                      <span className="text-caption text-muted-foreground">—</span>
                    ) : (
                      <RevokeButton id={item.id} onRevoked={reload} />
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
