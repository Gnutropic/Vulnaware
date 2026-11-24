// @polsia:user-owned — Wire contracts for /api/alerts/[id]/notes. Sibling
// of src/lib/contracts/alert-comments.ts so the assignee-thread envelope
// stays untouched. Client island imports the same schemas (single source
// of truth shared with the route handler).
//
// Distinct from AlertComment: an update note (assignee thread) labels the
// author by NAME; a handoff note (this pane) labels the author by EMAIL
// so a teammate scanning shift context sees the unambiguous identity at
// handoff time — emails collide less freely than names across the team.

import { z } from 'zod';

export const AlertNoteItem = z.object({
  id: z.string(),
  alertId: z.string(),
  authorUserId: z.string(),
  // Resolved in app code by batched `User.findMany`. Null when the
  // underlying User row is missing (deletion) — see handler comment.
  authorEmail: z.string().nullable(),
  body: z.string(),
  // ISO-8601 UTC ms — JS Date().toISOString().
  createdAt: z.string(),
});
export type AlertNoteItem = z.infer<typeof AlertNoteItem>;

export const AlertNoteList = z.object({
  items: z.array(AlertNoteItem),
});
export type AlertNoteList = z.infer<typeof AlertNoteList>;

export const AlertNoteCreateBody = z
  .object({
    // Trim is applied server-side before min(1) so leading/trailing ws
    // doesn't sneak past. MAX_BODY (2000) is intentionally tighter than
    // the assignee thread's 4000 because handoff notes are short — a
    // shift-to-shift breadcrumb, not a long-form update.
    body: z.string().trim().min(1, 'Body cannot be empty.').max(2000, 'Body is too long.'),
  })
  .strict();
export type AlertNoteCreateBody = z.infer<typeof AlertNoteCreateBody>;
