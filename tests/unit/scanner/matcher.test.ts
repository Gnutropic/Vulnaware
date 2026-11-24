// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Mock the OSV wrapper so the matcher's best-effort OSV path is reachable in
// tests without hitting the real network.
vi.mock('@/lib/business/scanner/cve-feed', () => ({
  queryOsv: vi.fn(async () => []),
  fetchCve: vi.fn(async () => null),
  CVE_ID_REGEX: /^CVE-\d{4}-\d{4,7}$/,
  isValidCveId: (id: string) => /^CVE-\d{4}-\d{4,7}$/.test(id),
}));

import { queryOsv } from '@/lib/business/scanner/cve-feed';
import { createMatcherContext, match } from '@/lib/business/scanner/matcher';

const base = { host: 'example.com', port: 443 } as const;

describe('match() — seed table', () => {
  it('flags Heartbleed on an OpenSSL 1.0.1 banner', async () => {
    const hits = await match({
      ...base,
      serviceHint: 'https',
      banner: 'OpenSSL/1.0.1e\r\n',
    });
    expect(hits.find((h) => h.cveId === 'CVE-2014-0160')).toBeDefined();
  });

  it('does NOT flag Heartbleed on OpenSSL 1.1.1 (bumped past the vulnerable range)', async () => {
    const hits = await match({
      ...base,
      serviceHint: 'https',
      banner: 'OpenSSL/1.1.1g\r\n',
    });
    expect(hits.find((h) => h.cveId === 'CVE-2014-0160')).toBeUndefined();
  });

  it('flags the OpenSSH agent-forwarding CVE on 8.0p1 but not 9.0p1', async () => {
    const v8 = await match({
      ...base,
      port: 22,
      serviceHint: 'ssh',
      banner: 'SSH-2.0-OpenSSH_8.4p1',
    });
    expect(v8.find((h) => h.cveId === 'CVE-2023-38408')).toBeDefined();

    const v9 = await match({
      ...base,
      port: 22,
      serviceHint: 'ssh',
      banner: 'SSH-2.0-OpenSSH_9.6p1',
    });
    expect(v9.find((h) => h.cveId === 'CVE-2023-38408')).toBeUndefined();
  });

  it('flags the vsftpd 2.3.4 backdoor as Critical', async () => {
    const hits = await match({
      ...base,
      port: 21,
      serviceHint: 'unknown',
      banner: 'vsftpd 2.3.4\r\n',
    });
    expect(
      hits.find((h) => h.cveId === 'CVE-2011-2523' && h.severity === 'Critical'),
    ).toBeDefined();
  });

  it('returns no hits when no banner is present', async () => {
    const hits = await match({
      ...base,
      serviceHint: 'https',
      banner: null,
    });
    expect(hits).toEqual([]);
  });

  it('returns no hits for a generic banner that matches no seed entry', async () => {
    const hits = await match({
      ...base,
      serviceHint: 'http',
      banner: 'Server: nginx/1.27.0 (unknown flavor)\r\n',
    });
    expect(hits).toEqual([]);
  });

  it('shares one OSV metadata read across checks with the same package and version', async () => {
    const queryResult = [{ id: 'CVE-2024-1234', summary: 'Sample OSV result', severity: 'High' }];
    vi.mocked(queryOsv).mockClear();
    vi.mocked(queryOsv).mockResolvedValue(queryResult);
    const context = createMatcherContext();
    const banner = 'nginx/1.27.0';

    const [firstCheck, secondCheck] = await Promise.all([
      match({ ...base, port: 80, serviceHint: 'nginx', banner }, context),
      match({ ...base, port: 8080, serviceHint: 'nginx', banner }, context),
    ]);

    expect(queryOsv).toHaveBeenCalledTimes(1);
    expect(queryOsv).toHaveBeenCalledWith('nginx', '1.27.0');
    expect(firstCheck).toEqual(secondCheck);
    expect(firstCheck).toEqual([
      {
        cveId: 'CVE-2024-1234',
        severity: 'High',
        matchReason: 'OSV.dev match for nginx@1.27.0 — Sample OSV result',
      },
    ]);
  });
});
