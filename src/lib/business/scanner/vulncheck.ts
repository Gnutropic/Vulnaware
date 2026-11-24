// @polsia:user-owned — Thin client around the VulnCheck NVD-CVE index.
// Best-effort only: fetch with a 10s deadline + one retry on 5xx, returns an
// empty map on any failure so a scan or live rescore never breaks when
// upstream is unreachable. Mirrors src/lib/business/scanner/{kev,epss}.ts.
//
// Endpoint shape:
//   POST /v3/nvdcve  with `{ cve: [list, of, ids] }` returns one hit per CVE
//   that appears in VulnCheck's NVD-CVE index. We use it for the canonical
//   "freshly listed, in-the-wild" signal the brief calls out — higher fidelity
//   than CISA KEV (broader source set) and fresher than EPSS (a probability
//   bucket, not a listing).
//
// When VULNCHECK_API_TOKEN is absent, returns the empty map (callers must
// still tolerate this — the scorer collapses the VulnCheck boost to 0).

import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface VulncheckHit {
  cveId: string;
  observedAt: Date;
  evidence: string | null;
  source: string;
}

const VulncheckRow = z.object({
  id: z.string().optional(),
  cve: z.object({ id: z.string().optional() }).optional(),
  // VulnCheck returns a per-cve published/added date. Either is acceptable.
  published: z.string().optional(),
  added: z.string().optional(),
  // `source` is a free-form string from the index (e.g. "vulncheck-nvd-cve").
  source: z.string().optional(),
  // Optional human-readable evidence (e.g. exploit-poc URL) — propagated to
  // VulncheckHit.evidence for audit rows.
  exploit: z.string().optional(),
});

const VulncheckResponse = z.object({
  data: z.array(VulncheckRow).optional(),
});

const VULNCHECK_URL = 'https://api.vulncheck.com/v3/nvdcve';

interface CatalogCache {
  at: number;
  data: Map<string, VulncheckHit>;
}

let cache: CatalogCache | null = null;
const VC_TTL_MS = 60_000; // 1 minute — VulnCheck updates much more often than KEV

export async function fetchVulncheckBatch(
  cveIds: string[],
  apiToken?: string | undefined,
): Promise<Map<string, VulncheckHit>> {
  const out = new Map<string, VulncheckHit>();
  if (cveIds.length === 0) return out;
  // No token → empty map; the caller collapses to no VulnCheck boost.
  if (!apiToken) return out;
  // Hot-path cache: a single scan or rescore call dedupes hits across the
  // entire batch. The 60s TTL matches the cron cadence floor.
  if (cache != null && Date.now() - cache.at < VC_TTL_MS) {
    for (const id of cveIds) {
      const hit = cache.data.get(id);
      if (hit) out.set(id, hit);
    }
    return out;
  }

  try {
    // POST body: `{ cve: ["CVE-...", ...] }` per VulnCheck API docs.
    const body = JSON.stringify({ cve: cveIds.slice(0, 200) });
    const response = await fetchWithRetry(body, apiToken);
    const parsed = VulncheckResponse.safeParse(response.body);
    if (!parsed.success) return out;
    const fetched = new Map<string, VulncheckHit>();
    for (const row of parsed.data.data ?? []) {
      const id = row.id ?? row.cve?.id;
      if (!id) continue;
      const ts = row.added ?? row.published;
      const observedAt = parseDate(ts) ?? new Date();
      const evidence = row.exploit ?? null;
      const source = row.source ?? 'vulncheck-nvd-cve';
      const hit: VulncheckHit = { cveId: id, observedAt, evidence, source };
      fetched.set(id, hit);
      out.set(id, hit);
    }
    cache = { at: Date.now(), data: fetched };
  } catch {
    // Best-effort — empty map on failure.
  }
  return out;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function fetchWithRetry(body: string, apiToken: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  try {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const res = await fetch(VULNCHECK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body,
        signal: controller.signal,
      });
      const respBody = (await res.json().catch(() => null)) as unknown;
      if (res.ok) return { status: res.status, body: respBody };
      // VulnCheck returns 401 when the token is bad; surface as a hard error
      // so the cursor records the cause (retrying with a bad token is futile).
      if (res.status === 401 || res.status === 403) {
        throw new Error(`vulncheck auth failed (${res.status})`);
      }
      if (res.status < 500) {
        throw new Error(`fetch ${VULNCHECK_URL} failed (${res.status})`);
      }
      lastError = new Error(`fetch ${VULNCHECK_URL} failed (${res.status})`);
    }
    throw lastError ?? new Error(`fetch ${VULNCHECK_URL} failed`);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: drop the in-process cache so the next call hits the network. */
export function _resetVulncheckCacheForTests(): void {
  cache = null;
}
