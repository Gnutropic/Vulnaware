// @polsia:user-owned — Thin client around the public CISA Known Exploited
// Vulnerabilities (KEV) catalog. Best-effort only: fetch with a 10s deadline +
// one retry on 5xx, never on 4xx. Returns an empty map on any failure so a
// scan never breaks when upstream is unreachable. Cached in-process for 24h
// so repeated scans during one worker lifetime do not refetch the catalog.

import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;
const KEV_TTL_MS = 24 * 60 * 60 * 1000;

export interface KevEntry {
  dateAdded: string;
}

const KevRow = z.object({
  cveID: z.string(),
  dateAdded: z.string(),
});

const KevCatalogSchema = z.object({
  vulnerabilities: z.array(KevRow),
});

const KEV_URL =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

interface CatalogCache {
  at: number;
  data: Map<string, KevEntry>;
}

let cache: CatalogCache | null = null;

/**
 * Best-effort KEV catalog fetch. Cached for 24h in-process; on any failure
 * (network, zod drift, 5xx) returns an empty map. Callers must tolerate the
 * empty-map path — it merely collapses to KEV_WEIGHT * 0 in the priority
 * formula.
 */
export async function fetchKevCatalog(): Promise<Map<string, KevEntry>> {
  if (cache != null && Date.now() - cache.at < KEV_TTL_MS) {
    return cache.data;
  }
  const fetched = await tryFetchCatalog();
  const data = fetched ?? new Map<string, KevEntry>();
  cache = { at: Date.now(), data };
  return data;
}

async function tryFetchCatalog(): Promise<Map<string, KevEntry> | null> {
  try {
    const response = await fetchWithRetry(KEV_URL);
    const parsed = KevCatalogSchema.safeParse(response.body);
    if (!parsed.success) return null;
    const out = new Map<string, KevEntry>();
    for (const row of parsed.data.vulnerabilities) {
      out.set(row.cveID, { dateAdded: row.dateAdded });
    }
    return out;
  } catch {
    return null;
  }
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

/** Test-only: drop the in-process cache so the next call hits the network. */
export function _resetKevCacheForTests(): void {
  cache = null;
}
