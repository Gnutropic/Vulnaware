// @polsia:user-owned — shared invite token helper. The only place that mints
// or rehashes invite tokens; both the issuer (POST /api/team/memberships/invite)
// and the lookup routes (GET / POST /api/invites/[token]) MUST import from here
// so the same `base64url`-then-`sha256hex` encoding is shared. A drift between
// issuer and lookup would silently 404 every valid invite.
//
// Plaintext tokens leave the server exactly once — in the issue email — and
// only the SHA-256 hex hash is persisted on the Invite row.

import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface InviteTokenPair {
  token: string;
  tokenHash: string;
}

export function mintInviteToken(): InviteTokenPair {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256hex(token) };
}

export function hashInviteToken(token: string): string {
  return sha256hex(token);
}
