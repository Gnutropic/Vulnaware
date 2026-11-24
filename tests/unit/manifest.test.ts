// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const brand = vi.hoisted(() => ({
  siteName: 'Acme',
  siteDescription: 'Acme app',
  brandVisual: {} as Record<string, unknown>,
}));

vi.mock('@/lib/brand', () => brand);
vi.mock('@/lib/env', () => ({ env: {} }));

import manifest from '@/app/manifest';

const SVG_ICON = { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' };

describe('manifest icons', () => {
  beforeEach(() => {
    brand.brandVisual = { themeColor: '#000000', backgroundColor: '#ffffff' };
  });

  it('falls back to /icon.svg when brand.ts predates the icons field', () => {
    expect(manifest().icons).toEqual([SVG_ICON]);
  });

  it('falls back to /icon.svg when icons is empty', () => {
    brand.brandVisual.icons = [];
    expect(manifest().icons).toEqual([SVG_ICON]);
  });

  it('lists the brand icons', () => {
    const icons = [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ];
    brand.brandVisual.icons = icons;
    expect(manifest().icons).toEqual(icons);
  });
});

describe('manifest short_name', () => {
  beforeEach(() => {
    brand.brandVisual = { themeColor: '#000000', backgroundColor: '#ffffff' };
  });

  it('falls back to siteName when brand.ts predates the shortName field', () => {
    expect(manifest().short_name).toBe('Acme');
  });

  it('falls back to siteName when shortName is empty', () => {
    brand.brandVisual.shortName = '';
    expect(manifest().short_name).toBe('Acme');
  });

  it('uses the brand shortName', () => {
    brand.brandVisual.shortName = 'Acm';
    expect(manifest().short_name).toBe('Acm');
  });
});
