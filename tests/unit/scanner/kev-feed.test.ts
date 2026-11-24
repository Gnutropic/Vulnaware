// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetKevCacheForTests, fetchKevCatalog, type KevEntry } from '@/lib/business/scanner/kev';

interface MockResp {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const makeResponse = (status: number, body: unknown): MockResp => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const KEVSAMPLE = {
  title: 'CISA KEV catalog',
  catalogVersion: '2026.07.21',
  dateReleased: '2026-07-21',
  count: 2,
  vulnerabilities: [
    { cveID: 'CVE-2021-44228', dateAdded: '2021-12-10' },
    { cveID: 'CVE-2017-5638', dateAdded: '2017-03-16' },
  ],
};

describe('fetchKevCatalog', () => {
  beforeEach(() => {
    _resetKevCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a valid catalog envelope into a cveID-keyed map with dateAdded preserved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(200, KEVSAMPLE)),
    );

    const map = await fetchKevCatalog();
    expect(map.size).toBe(2);
    const a: KevEntry | undefined = map.get('CVE-2021-44228');
    expect(a?.dateAdded).toBe('2021-12-10');
    expect(map.get('CVE-2017-5638')?.dateAdded).toBe('2017-03-16');
  });

  it('returns an empty map when the JSON envelope drifts from the zod schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse(200, { vulnerabilities: [{ cveID: 'CVE-X', dateAdded: 12345 }] }),
      ),
    );
    const map = await fetchKevCatalog();
    expect(map.size).toBe(0);
  });

  it('does not retry on 4xx and surfaces an empty map', async () => {
    const fakeFetch = vi.fn(async () => makeResponse(404, { error: 'not found' }));
    vi.stubGlobal('fetch', fakeFetch);

    const map = await fetchKevCatalog();
    expect(map.size).toBe(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx then succeeds, returning the parsed map', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, { error: 'try later' }))
      .mockResolvedValueOnce(makeResponse(200, KEVSAMPLE));
    vi.stubGlobal('fetch', fakeFetch);

    const map = await fetchKevCatalog();
    expect(map.size).toBe(2);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('returns an empty map when the final 5xx attempt also fails', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(502, { error: 'bad gateway' }))
      .mockResolvedValueOnce(makeResponse(500, { error: 'oops' }));
    vi.stubGlobal('fetch', fakeFetch);

    const map = await fetchKevCatalog();
    expect(map.size).toBe(0);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });
});
