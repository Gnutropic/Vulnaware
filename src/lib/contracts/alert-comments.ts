// @polsia:user-owned — Wire contracts for /api/alerts/[id]/comments.
// Sibling of src/lib/contracts/alerts.ts so the list/detail envelope
// stays untouched. Client island imports the same schemas (single
// source of truth shared with the route handler).

import { z } from 'zod';

export const AlertCommentItem = z.object({
  id: z.string(),
  alertId: z.string(),
  authorId: z.string(),
  // Resolved in app code by batched `User.findMany`. Null when the
  // underlying User row is missing (deletion) — see handler comment.
  authorName: z.string().nullable(),
  body: z.string(),
  // ISO-8601 UTC ms — JS Date().toISOString().
  createdAt: z.string(),
});
export type AlertCommentItem = z.infer<typeof AlertCommentItem>;

export const AlertCommentList = z.object({
  items: z.array(AlertCommentItem),
});
export type AlertCommentList = z.infer<typeof AlertCommentList>;

export const AlertCommentCreateBody = z
  .object({
    // Trim is applied server-side before min(1) so leading/trailing ws
    // doesn't sneak past. MAX_BODY matches the typical patch-note size
    // budget and keeps a runaway composer from blowing up a row.
    body: z.string().trim().min(1, 'Body cannot be empty.').max(4000, 'Body is too long.'),
  })
  .strict();
export type AlertCommentCreateBody = z.infer<typeof AlertCommentCreateBody>;
