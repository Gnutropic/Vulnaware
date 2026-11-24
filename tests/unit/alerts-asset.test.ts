// Pure Node tests for the asset filter helpers. Locks the round-trip
// contract between the alerts page's chip row, the URL writer
// (`buildEffectiveQs`), and the route handlers (`/api/alerts` and
// `/api/alerts/export.csv`).
//
// Wire identity shape: `${host}:${port}/${protocol}`. Unlike severity
// (whose enum is sealed), the asset composite key is open-ended —
// `prisma.asset.host + port + protocol` can produce anything. The
// helpers below split / trim / dedupe / canonical-sort, and the
// route-side `parseAssetNamesToOrList` is the single point that DOES
// validate the strict host/port/protocol shape (throws
// `AssetFilterError`).

import { describe, expect, it } from 'vitest';
import {
  AssetFilterError,
  formatAssetFilter,
  MAX_ASSET_FILTER_ENTRIES,
  parseAssetFilter,
  parseAssetName,
  parseAssetNamesToOrList,
} from '@/lib/business/alerts-asset';

describe('parseAssetFilter', () => {
  it('parses a single composite name', () => {
    expect(parseAssetFilter('example.com:443/tcp')).toEqual(['example.com:443/tcp']);
  });

  it('parses two comma-separated composite names', () => {
    expect(parseAssetFilter('example.com:443/tcp,vpn.example.com:80/udp')).toEqual([
      'example.com:443/tcp',
      'vpn.example.com:80/udp',
    ]);
  });

  it('parses a list of N composite names (no upper cap on the parser side)', () => {
    const names = Array.from({ length: 12 }, (_, i) => `host${i}.example.com:443/tcp`);
    expect(parseAssetFilter(names.join(','))).toEqual(names);
  });

  it('returns names in alphabetical canonical order regardless of input order', () => {
    expect(parseAssetFilter('baz:80/tcp,foo:443/tcp,bar:443/udp')).toEqual([
      'bar:443/udp',
      'baz:80/tcp',
      'foo:443/tcp',
    ]);
  });

  it('returns [] for null / undefined / empty', () => {
    expect(parseAssetFilter(null)).toEqual([]);
    expect(parseAssetFilter(undefined)).toEqual([]);
    expect(parseAssetFilter('')).toEqual([]);
  });

  it('tolerates whitespace around each entry', () => {
    expect(parseAssetFilter(' example.com:443/tcp , vpn.example.com:80/udp ')).toEqual([
      'example.com:443/tcp',
      'vpn.example.com:80/udp',
    ]);
  });

  it('dedupes repeated entries case-sensitively', () => {
    expect(parseAssetFilter('a:1/tcp,a:1/tcp,b:2/tcp')).toEqual(['a:1/tcp', 'b:2/tcp']);
  });

  it('does NOT validate the host/port/protocol shape (free-form at the chip layer)', () => {
    // The page-level parser is permissive — bad shapes drop to "still
    // parsed" here, only the strict `parseAssetNamesToOrList` (used by
    // the route) rejects malformed strings. This keeps the chip row
    // tolerant of a partially-fresh asset-options endpoint.
    expect(parseAssetFilter('totally-not-a-name')).toEqual(['totally-not-a-name']);
  });

  it('returns [] for an all-whitespace input', () => {
    expect(parseAssetFilter(' , , ')).toEqual([]);
  });
});

describe('formatAssetFilter', () => {
  it('emits CSV in alphabetical canonical order from a Set without preserving insertion order', () => {
    expect(formatAssetFilter(new Set(['foo:443/tcp', 'bar:80/udp']))).toBe(
      'bar:80/udp,foo:443/tcp',
    );
    expect(formatAssetFilter(new Set(['z:1/tcp', 'a:2/tcp', 'm:3/tcp']))).toBe(
      'a:2/tcp,m:3/tcp,z:1/tcp',
    );
  });

  it('returns null when the Set is empty', () => {
    expect(formatAssetFilter(new Set())).toBe(null);
  });

  it('returns null when the Set is null or undefined', () => {
    expect(formatAssetFilter(null)).toBe(null);
    expect(formatAssetFilter(undefined)).toBe(null);
  });

  it('formats a single-element Set', () => {
    expect(formatAssetFilter(new Set(['only:443/tcp']))).toBe('only:443/tcp');
  });
});

describe('parseAssetFilter ↔ formatAssetFilter round-trip', () => {
  it('round-trips a single composite name', () => {
    const set = new Set(['example.com:443/tcp']);
    const formatted = formatAssetFilter(set);
    expect(formatted).toBe('example.com:443/tcp');
    expect(parseAssetFilter(formatted)).toEqual(['example.com:443/tcp']);
  });

  it('round-trips a non-canonical Set order into the canonical CSV', () => {
    const set = new Set(['z:1/tcp', 'a:2/tcp']);
    const formatted = formatAssetFilter(set);
    expect(formatted).toBe('a:2/tcp,z:1/tcp');
    expect(parseAssetFilter(formatted)).toEqual(['a:2/tcp', 'z:1/tcp']);
  });

  it('round-trips arbitrary-size Sets (canonical CSV → Set → canonical CSV)', () => {
    const set = new Set(['beta:80/tcp', 'alpha:443/tcp', 'gamma:22/udp']);
    const formatted = formatAssetFilter(set);
    const parsed = new Set(parseAssetFilter(formatted));
    expect(parsed).toEqual(set);
    expect(formatAssetFilter(parsed)).toBe(formatted);
  });
});

describe('parseAssetName', () => {
  it('returns a triplet for a well-formed composite name', () => {
    expect(parseAssetName('example.com:443/tcp')).toEqual({
      host: 'example.com',
      port: 443,
      protocol: 'tcp',
    });
  });

  it('returns null for an empty / non-string input', () => {
    expect(parseAssetName('')).toBeNull();
  });

  it('returns null for a name missing the port', () => {
    expect(parseAssetName('example.com:tcp')).toBeNull();
  });

  it('returns null for a name missing the protocol', () => {
    expect(parseAssetName('example.com:443')).toBeNull();
  });

  it('returns null for a name with a non-integer port', () => {
    expect(parseAssetName('example.com:abc/tcp')).toBeNull();
  });

  it('returns null for a port out of the valid range (0 / above max)', () => {
    expect(parseAssetName('example.com:0/tcp')).toBeNull();
    expect(parseAssetName('example.com:65536/tcp')).toBeNull();
  });

  it('returns null for a name with extra colons in the host', () => {
    // Strict shape: the regex only accepts a host with no `:`
    expect(parseAssetName('example.com:443:8080/tcp')).toBeNull();
  });
});

describe('parseAssetNamesToOrList', () => {
  it('returns [] for empty / null input (no asset filter drops the OR arm cleanly)', () => {
    expect(parseAssetNamesToOrList(null)).toEqual([]);
    expect(parseAssetNamesToOrList(undefined)).toEqual([]);
    expect(parseAssetNamesToOrList('')).toEqual([]);
  });

  it('returns the composite triplet array for a single well-formed name', () => {
    expect(parseAssetNamesToOrList('example.com:443/tcp')).toEqual([
      { host: 'example.com', port: 443, protocol: 'tcp' },
    ]);
  });

  it('returns a triplet array for two well-formed names', () => {
    expect(parseAssetNamesToOrList('example.com:443/tcp,vpn.example.com:80/udp')).toEqual([
      { host: 'example.com', port: 443, protocol: 'tcp' },
      { host: 'vpn.example.com', port: 80, protocol: 'udp' },
    ]);
  });

  it('returns a triplet array for the MAX_ASSET_FILTER_ENTRIES cap', () => {
    const names = Array.from(
      { length: MAX_ASSET_FILTER_ENTRIES },
      (_, i) => `host${i}.example.com:${1024 + (i % 1024)}/tcp`,
    );
    const out = parseAssetNamesToOrList(names.join(','));
    expect(out).toHaveLength(MAX_ASSET_FILTER_ENTRIES);
  });

  it('throws AssetFilterError("too_many_entries") when the CSV exceeds the cap', () => {
    const names = Array.from(
      { length: MAX_ASSET_FILTER_ENTRIES + 1 },
      (_, i) => `host${i}.example.com:${1024 + (i % 1024)}/tcp`,
    );
    expect(() => parseAssetNamesToOrList(names.join(','))).toThrow(AssetFilterError);
    try {
      parseAssetNamesToOrList(names.join(','));
      expect.fail('expected AssetFilterError');
    } catch (err) {
      expect(err).toBeInstanceOf(AssetFilterError);
      expect((err as AssetFilterError).code).toBe('too_many_entries');
      expect((err as AssetFilterError).message).toContain(String(MAX_ASSET_FILTER_ENTRIES));
    }
  });

  it('throws AssetFilterError("malformed_name") on a name that fails the shape regex', () => {
    expect(() => parseAssetNamesToOrList('totally-not-a-name')).toThrow(AssetFilterError);
    try {
      parseAssetNamesToOrList('foo');
      expect.fail('expected AssetFilterError');
    } catch (err) {
      expect(err).toBeInstanceOf(AssetFilterError);
      expect((err as AssetFilterError).code).toBe('malformed_name');
    }
  });

  it('throws the first malformed-name error even when earlier entries are well-formed', () => {
    // Same posture as the too-many cap: surface one clear error so the
    // route can 400 with a readable toast. The strict `parseAssetName`
    // helper runs in input-order, so a malformed entry mid-list trips
    // the throw before any later (also-malformed) entry is examined.
    expect(() => parseAssetNamesToOrList('example.com:443/tcp,broken,b:1/tcp')).toThrow(
      AssetFilterError,
    );
  });
});
