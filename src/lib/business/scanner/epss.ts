// @polsia:user-owned — Thin client around the FIRST EPSS public API.
// Best-effort only: fetch with a 5s deadline + one retry on 5xx, returns an
// empty map on failure so a scan never breaks when the upstream is
// unreachable.

import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface EpssEntry {
  epssScore: number;
  epssPercentile: number;
}

const EpssEntrySchema = z.object({
  cve: z.string().optional(),
  epssScore: z.string().optional(),
  percentile: z.string().optional(),
});

const EpssResponseSchema = z.object({
  data: z.array(EpssEntrySchema),
});

const EPSS_URL = 'https://api.first.org/data/v1/epss';

export async function fetchEpssBatch(cveIds: string[]): Promise<Map<string, EpssEntry>> {
  const out = new Map<string, EpssEntry>();
  if (cveIds.length === 0) return out;

  const params = new URLSearchParams();
  for (const id of cveIds) params.append('cve', id);
  const url = `${EPSS_URL}?${params.toString()}`;

  try {
    const response = await fetchWithRetry(url);
    const parsed = EpssResponseSchema.safeParse(response.body);
    if (!parsed.success) return out;
    for (const row of parsed.data.data) {
      if (!row.cve) continue;
      const score = Number.parseFloat(row.epssScore ?? '');
      const percentile = Number.parseFloat(row.percentile ?? '');
      if (!Number.isFinite(score) || !Number.isFinite(percentile)) continue;
      out.set(row.cve, { epssScore: score, epssPercentile: percentile });
    }
  } catch {
    // Best-effort — empty map on failure.
  }
  return out;
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function fetchWithRetry(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  try {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const res = await fetch(url, { signal: controller.signal });
      const body = (await res.json().catch(() => null)) as unknown;
      if (res.ok) return { status: res.status, body };
      if (res.status < 500) {
        throw new Error(`fetch ${url} failed (${res.status})`);
      }
      lastError = new Error(`fetch ${url} failed (${res.status})`);
    }
    throw lastError ?? new Error(`fetch ${url} failed`);
  } finally {
    clearTimeout(timer);
  }
}
