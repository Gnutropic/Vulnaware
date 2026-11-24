// @polsia:user-owned — Shared predicate for the /assets unresolved-alert
// presence filter. It stays pure so the API and focused unit checks use the
// same all/with/without semantics.

import type { AssetAlertPresence } from '@/lib/contracts/assets';

export function matchesAssetAlertPresence(
  unresolvedCount: number,
  presence: AssetAlertPresence,
): boolean {
  if (presence === 'with') return unresolvedCount > 0;
  if (presence === 'without') return unresolvedCount === 0;
  return true;
}
