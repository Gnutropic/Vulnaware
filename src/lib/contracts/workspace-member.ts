// @polsia:user-owned — zod contract for the WorkspaceMember surface
// (POST /api/team/invite). Mirrors the style of src/lib/contracts/invites.ts
// so the issuer and acceptor share a sibling shape; the role picker is
// intentionally absent on the issuer — admins invite as 'member' and promote
// from the roster table after the recipient lands.

import { z } from 'zod';

// Narrower enum than `MembershipRole` — the WorkspaceMember roster does not
// expose a 'viewer' tier; legacy `Membership` rows may still carry it for
// backward compatibility.
export const WorkspaceMemberRole = z.enum(['admin', 'member']);
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRole>;

export const WorkspaceMemberStatus = z.enum(['active', 'invited']);
export type WorkspaceMemberStatus = z.infer<typeof WorkspaceMemberStatus>;

// POST body — invite a person by email. The recipient MAY or MAY NOT already
// have an account; the email lands either way. Mirrors InviteCreate (TTL
// bounds, trim+lowercase email) so the two endpoints stay symmetric.
export const WorkspaceMemberInviteCreate = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required.'),
  ttlSeconds: z.coerce
    .number()
    .int('ttlSeconds must be a whole number.')
    .positive('ttlSeconds must be positive.')
    .min(300, 'ttlSeconds must be at least 300 (5 minutes).')
    .max(60 * 60 * 24 * 30, 'ttlSeconds must be at most 30 days.'),
});

// Wire shape returned to the client after POST. Pending row only — accepts
// flip the row to status='active' and the GET roster picks it up. Token
// state lives on the Invite row (kept in the legacy table so the existing
// /api/invites/[token] lookup works unchanged).
export const WorkspaceMemberInviteItem = z.object({
  id: z.string(),
  email: z.string().email(),
  workspaceId: z.string(),
  role: WorkspaceMemberRole,
  status: WorkspaceMemberStatus,
  invitedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type WorkspaceMemberInviteCreate = z.infer<typeof WorkspaceMemberInviteCreate>;
export type WorkspaceMemberInviteCreateInput = z.input<typeof WorkspaceMemberInviteCreate>;
export type WorkspaceMemberInviteItem = z.infer<typeof WorkspaceMemberInviteItem>;
