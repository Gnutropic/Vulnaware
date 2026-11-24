// @polsia:user-owned — shared zod contract for the changelog resource.
// Imported by both the /api/changelog route handler and the
// /components/custom/changelog/changelog-list.tsx client island so a shape
// change is a tsc error / runtime ZodError, not silent drift.
// Keep contract modules client-importable: zod only, no server-only imports.
import { z } from 'zod';

export const ChangelogEntry = z
  .object({
    /** Stable, date-free slug used for React keys and in-page anchors. */
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    /** Short headline for the entry. */
    title: z.string().min(1),
    /** Factual summary, rendered through the safe-subset helper before it ships HTML. */
    body: z.string().min(1),
  })
  .strict();

export const ChangelogList = z.object({
  entries: z.array(ChangelogEntry),
});

export type ChangelogEntry = z.infer<typeof ChangelogEntry>;
export type ChangelogList = z.infer<typeof ChangelogList>;
