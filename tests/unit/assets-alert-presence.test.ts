import { describe, expect, it } from 'vitest';
import { matchesAssetAlertPresence } from '@/lib/business/assets-alert-presence';
import { AssetQuery } from '@/lib/contracts/assets';

describe('assets unresolved-alert presence filter', () => {
  it('matches all, with, and without against the existing unresolved count', () => {
    expect(matchesAssetAlertPresence(0, 'all')).toBe(true);
    expect(matchesAssetAlertPresence(3, 'all')).toBe(true);
    expect(matchesAssetAlertPresence(3, 'with')).toBe(true);
    expect(matchesAssetAlertPresence(0, 'with')).toBe(false);
    expect(matchesAssetAlertPresence(0, 'without')).toBe(true);
    expect(matchesAssetAlertPresence(3, 'without')).toBe(false);
  });

  it('defaults omitted or empty URL values to all assets', () => {
    expect(AssetQuery.parse({}).alertPresence).toBe('all');
    expect(AssetQuery.parse({ alertPresence: '' }).alertPresence).toBe('all');
    expect(AssetQuery.parse({ alertPresence: 'with' }).alertPresence).toBe('with');
    expect(AssetQuery.parse({ alertPresence: 'without' }).alertPresence).toBe('without');
  });
});
