// @polsia:user-owned — Asset table island. Renders AwsAssetItem[] with a
// glanceable per-row exposure badge. No server imports; the caller passes
// the typed array in.

'use client';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AwsAssetItem } from '@/lib/contracts/aws';

export function AwsAssetTable({ assets }: { assets: AwsAssetItem[] }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card shadow-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Region</TableHead>
            <TableHead>Resource type</TableHead>
            <TableHead>Exposure</TableHead>
            <TableHead>ARN / id</TableHead>
            <TableHead>Hint</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {assets.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5}>
                <div className="px-2 py-6 text-caption text-muted-foreground">
                  Discovery succeeded but no AWS assets surfaced.
                </div>
              </TableCell>
            </TableRow>
          ) : (
            assets.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Badge variant="outline">{a.region}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{a.resourceType}</Badge>
                </TableCell>
                <TableCell>
                  {a.publicExposure === 'public' ? (
                    <Badge variant="destructive">public</Badge>
                  ) : a.publicExposure === 'private' ? (
                    <Badge>private</Badge>
                  ) : (
                    <Badge variant="outline">unknown</Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-[24rem] truncate font-mono text-caption text-muted-foreground">
                  {a.resourceArn}
                </TableCell>
                <TableCell className="text-caption text-muted-foreground">
                  {a.serviceHint ?? '—'}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
