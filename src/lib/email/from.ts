// @polsia:user-owned — single source of truth for the per-category
// transactional sender. Owned so future dispatch code can import one symbol
// instead of re-reading env vars inline. Pure mapping; does not call send.

import { env } from '@/lib/env';

export type EmailCategory = 'alerts' | 'vuln' | 'invites' | 'trial' | 'digest';

export function fromFor(category: EmailCategory): string {
  switch (category) {
    case 'alerts':
      return env.EMAIL_FROM_ALERTS;
    case 'vuln':
      return env.EMAIL_FROM_VULN;
    case 'invites':
      return env.EMAIL_FROM_INVITES;
    case 'trial':
      return env.EMAIL_FROM_TRIAL;
    case 'digest':
      return env.EMAIL_FROM_DIGEST;
  }
}
