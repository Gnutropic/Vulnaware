// @polsia:user-owned — zod contract for the invites surface. Pure zod — no
// server-only imports so client islands and server handlers share one shape
// (used by apiFetch's schema option for runtime drift detection). Mirrors the
// style of src/lib/contracts/team.ts and src/lib/contracts/api-key.ts.

import { z } from 'zod';

// ─── Issuer (POST /api/team/memberships/invite) ───────────────────────────

// Minimum viable TTL (5 minutes) so a freshly minted token isn't burned
// before the recipient clicks through. Maximum (30 days) so the operator
// can't accidentally issue a permanent password reset–style URL.
export const InviteCreate = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required.'),
  ttlSeconds: z.coerce
    .number()
    .int('ttlSeconds must be a whole number.')
    .positive('ttlSeconds must be positive.')
    .min(300, 'ttlSeconds must be at least 300 (5 minutes).')
    .max(60 * 60 * 24 * 30, 'ttlSeconds must be at most 30 days.'),
});

// Wire shape returned to the client after POST. Date columns serialize to
// ISO-8601 strings so the client island can hydrate without losing
// timezone information.
export const InviteItem = z.object({
  id: z.string(),
  email: z.string().email(),
  teamId: z.string(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

// ─── Lookup (GET /api/invites/[token]) ────────────────────────────────────

// Public shape for the lookup endpoint. The token resolves to a pending
// row, a consumed row, or is unknown/expired — the route shapes the result
// into InviteStatus below so the client island can branch without parsing
// HTTP statuses. Internal ids and `tokenHash` are NEVER returned.
export const InviteRead = z.object({
  email: z.string().email(),
  teamName: z.string(),
  existingUser: z.boolean(),
});
export type InviteRead = z.infer<typeof InviteRead>;

// Discriminated union returned by GET /api/invites/[token] so the client
// island renders deterministically without re-checking HTTP statuses. The
// HTTP code (200/404/410) maps 1:1 onto status here — the route throws the
// shape, never the status, on the client.
export const InviteStatus = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    email: z.string().email(),
    teamName: z.string(),
    existingUser: z.boolean(),
  }),
  z.object({ status: z.literal('consumed') }),
  z.object({ status: z.literal('invalid') }),
]);
export type InviteStatus = z.infer<typeof InviteStatus>;

// ─── Accept (POST /api/invites/[token]/accept) ───────────────────────────

// Body for POST /api/invites/[token]/accept. Password is mandatory for the
// existing-user path; `name` is only required for the signup path but is
// sent unconditionally so the server branches on `existingUser` itself.
export const InviteAcceptRequest = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  name: z.string().min(1).max(120).optional(),
});
export type InviteAcceptRequest = z.infer<typeof InviteAcceptRequest>;

export const InviteAcceptResponse = z.object({
  ok: z.literal(true),
  redirect: z.string().startsWith('/'),
});
export type InviteAcceptResponse = z.infer<typeof InviteAcceptResponse>;

export type InviteCreate = z.infer<typeof InviteCreate>;
export type InviteCreateInput = z.input<typeof InviteCreate>;
export type InviteItem = z.infer<typeof InviteItem>;
export type InviteItemInput = z.output<typeof InviteItem>;
