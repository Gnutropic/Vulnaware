// @polsia:user-owned — Cancellable keyset pagination for scoped CSV reads.

export const CSV_SUPPORT_READ_BATCH_SIZE = 5_000;

export async function forEachIdPage<T extends { id: string }>(input: {
  signal: AbortSignal;
  fetchPage: (afterId: string | undefined) => Promise<T[]>;
  consume: (rows: T[]) => Promise<void>;
}): Promise<void> {
  let afterId: string | undefined;
  while (true) {
    if (input.signal.aborted) throw new Error('CSV export cancelled');
    const rows = await input.fetchPage(afterId);
    if (input.signal.aborted) throw new Error('CSV export cancelled');
    if (rows.length === 0) return;
    await input.consume(rows);
    if (rows.length < CSV_SUPPORT_READ_BATCH_SIZE) return;
    const lastRow = rows.at(-1);
    if (!lastRow) return;
    afterId = lastRow.id;
  }
}
