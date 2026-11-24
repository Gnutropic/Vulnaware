// @polsia:user-owned — zod contract for /api/team/memberships** + /api/team/bootstrap-owner.
// Mirrors the api-key.ts style — pure zod, no server-only imports so the
// server handlers and client islands parse the same wire shape.

import { z } from 'zod';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '@/lib/permissions/roles';

// Re-export role primitives so client islands can pull wire shapes + UI
// labels from a single import surface.
export { ROLE_LABELS, ROLE_DESCRIPTIONS, type Role };

export const MembershipRole = z.enum(['admin', 'member', 'viewer']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const MembershipRowRole = z.enum(['admin', 'member', 'viewer']);

// Roster entry for the /settings/team page. Unifies two underlying tables
// (`Membership` for active members, `WorkspaceMember` for pending invites)
// onto one wire shape so the client island renders a single source of truth
// without bumping a contract on every status change.
export const MembershipStatus = z.enum(['active', 'invited']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

export const MembershipItem = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  email: z.string().email().nullable(),
  name: z.string().nullable(),
  role: MembershipRowRole,
  status: MembershipStatus,
  invitedAt: z.string().datetime().nullable(),
  joinedAt: z.string().datetime().nullable(),
  createdAt: z.string(),
});

export const MembershipList = z.object({
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
  items: z.array(MembershipItem),
});

// POST body — invite by existing email. Assigning by an existing user's
// email rather than an open invite keeps signup side-effects off the
// critical path of the settings form.
export const MembershipAssign = z.object({
  email: z.string().email('A valid email is required.'),
  role: MembershipRole,
});

// PATCH body — at minimum a role.
export const MembershipRoleUpdate = z.object({
  role: MembershipRole,
});

// Minimal roster shape used by /api/team/members (and the alerts page's
// `Owner` picker). Distinct from `MembershipItem` so the picker payload
// stays narrow: just id + display label + email. Pending invites are not
// included — an unowned CVE can't be assigned to a not-yet-onboarded
// colleague, and surfacing them in the picker just produces a 400 on
// submit. `name` falls back to email in the route when `User.name` is
// missing so the picker always has a usable label.
export const MemberOption = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

export const MemberOptionList = z.object({
  items: z.array(MemberOption),
});

// Served by GET /api/team/membership — the caller's own
// WorkspaceMember row for the current team, plus the resolved
// display name. Narrow companion to `MemberOption`: just the
// caller's row, so a page-side imperative handle can seed
// `callerWorkspaceMemberIdRef` and `callerNameRef` from a single
// round-trip without dragging the full roster into state. The
// fields match `WorkspaceMember.findFirst({ select: { id,
// userId, email } })` direct projection + a peer-read of
// `User.name`. `email` may be null on a freshly-bootstrap row
// (narrow contract for the page-side helper; the picker uses
// `MemberOption` for the full roster with a stricter email-gate).
// `name` is null when User.name is missing so the optimistic
// flip's ownerName mirror degrades to "unknown owner" without
// an extra round trip.
export const TeamMembership = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});
export type TeamMembership = z.infer<typeof TeamMembership>;

export const BootstrapOwnerResponse = z.object({
  ok: z.boolean(),
  teamId: z.string().nullable(),
});

export type MembershipItem = z.infer<typeof MembershipItem>;
export type MembershipList = z.infer<typeof MembershipList>;
export type MembershipAssign = z.infer<typeof MembershipAssign>;
export type MembershipAssignInput = z.input<typeof MembershipAssign>;
export type MembershipRoleUpdate = z.infer<typeof MembershipRoleUpdate>;
export type MembershipRoleUpdateInput = z.input<typeof MembershipRoleUpdate>;
export type BootstrapOwnerResponse = z.infer<typeof BootstrapOwnerResponse>;
export type MemberOption = z.infer<typeof MemberOption>;
export type MemberOptionList = z.infer<typeof MemberOptionList>;
