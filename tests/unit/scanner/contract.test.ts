// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PORT_ALLOWLIST, ScanCreate, ScanItem, ScanList } from '@/lib/contracts/scan';

// Reusable cast — the contract is shared by the route handler + client island.
const validPayload = {
  target: 'scanme.example.org',
  ports: [22, 80, 443],
  mode: 'tcp-only' as const,
};

describe('PORT_ALLOWLIST', () => {
  it('accepts the documented MVP allowlist', () => {
    for (const p of [22, 80, 443, 8080, 8443]) {
      expect(PORT_ALLOWLIST.safeParse(p).success).toBe(true);
    }
  });

  it('rejects ports outside the allowlist', () => {
    for (const p of [21, 25, 53, 3306, 5432, 6379, 11211, 8000]) {
      expect(PORT_ALLOWLIST.safeParse(p).success).toBe(false);
    }
  });
});

describe('ScanCreate', () => {
  it('accepts a valid public hostname with allowlisted ports', () => {
    expect(ScanCreate.safeParse(validPayload).success).toBe(true);
  });

  it('accepts a public IPv4 literal', () => {
    expect(ScanCreate.safeParse({ target: '8.8.8.8', ports: [443] }).success).toBe(true);
  });

  it('accepts a public IPv6 literal', () => {
    expect(ScanCreate.safeParse({ target: '2606:4700:4700::1111', ports: [443] }).success).toBe(
      true,
    );
  });

  it('rejects private IPv4 (10.0.0.0/8, 192.168.0.0/16, 172.16-31)', () => {
    for (const target of ['10.1.2.3', '192.168.0.1', '172.20.10.4']) {
      const result = ScanCreate.safeParse({ target, ports: [443] });
      expect(result.success).toBe(false);
    }
  });

  it('rejects loopback, link-local and reserved IPv4 ranges', () => {
    for (const target of [
      '127.0.0.1',
      '169.254.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '100.64.0.1',
    ]) {
      const result = ScanCreate.safeParse({ target, ports: [443] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.flatten().fieldErrors.target?.[0]).toMatch(/public/i);
      }
    }
  });

  it('rejects loopback + IPv6 ULA + IPv6 link-local', () => {
    for (const target of ['::1', 'fc00::1', 'fd00::beef', 'fe80::1']) {
      const result = ScanCreate.safeParse({ target, ports: [443] });
      expect(result.success).toBe(false);
    }
  });

  it('rejects empty ports and oversized arrays', () => {
    expect(ScanCreate.safeParse({ target: 'example.com', ports: [] }).success).toBe(false);
    expect(
      ScanCreate.safeParse({ target: 'example.com', ports: [22, 80, 443, 8080, 8443, 22] }).success,
    ).toBe(false);
  });

  it('rejects a malformed hostname', () => {
    expect(ScanCreate.safeParse({ target: '-bad-.com', ports: [443] }).success).toBe(false);
    expect(ScanCreate.safeParse({ target: '', ports: [443] }).success).toBe(false);
  });
});

describe('ScanList', () => {
  it('accepts an empty list', () => {
    expect(ScanList.safeParse({ items: [] }).success).toBe(true);
  });

  it('rejects when an item is missing the server-generated id', () => {
    const payload = {
      target: 'example.com',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      assets: [],
      findings: [],
    };
    expect(ScanList.safeParse({ items: [payload] }).success).toBe(false);
  });

  it('rejects an asset row missing required fields', () => {
    const payload = {
      id: 'x1',
      target: 'example.com',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      assets: [{ host: 'example.com' /* missing required keys */ }],
      findings: [],
    };
    expect(ScanList.safeParse({ items: [payload] }).success).toBe(false);
  });

  it('accepts a fully-shaped item with assets + findings', () => {
    const item = ScanItem.parse({
      id: 'scan-1',
      target: 'example.com',
      mode: 'tcp-only',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      assets: [
        {
          id: 'a1',
          host: 'example.com',
          ip: '93.184.216.34',
          port: 443,
          protocol: 'tcp',
          state: 'up',
          latencyMs: 32,
          serviceHint: 'https',
          banner: null,
        },
      ],
      findings: [
        {
          id: 'f1',
          assetId: 'a1',
          cveId: 'CVE-2014-0160',
          severity: 'High',
          matchReason: 'Heartbleed',
        },
      ],
    });
    expect(item.assets).toHaveLength(1);
    expect(item.findings[0]?.cveId).toBe('CVE-2014-0160');
  });
});
