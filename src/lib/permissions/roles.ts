// @polsia:user-owned — Team role primitives shared between server (api route
// handlers, server components) and client (settings UI islands). Pure types
// and helpers — no server-only imports, safe to import from 'use client'.

export type Role = 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full access — manage members and roles, run and view scans.',
  member: 'Run scans and view results for this team.',
  viewer: 'Read-only — view scans owned by this team.',
};

export function hasAtLeast(actual: string | null | undefined, min: Role): boolean {
  if (!actual) return false;
  const a = ROLE_RANK[actual as Role];
  const m = ROLE_RANK[min];
  if (a === undefined || m === undefined) return false;
  return a >= m;
}
