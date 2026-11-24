// @polsia:user-owned — Origin resolver + allowlist for billing POSTs.
//
// All Stripe-mutating routes (POST /api/billing/{tier-subscribe,
// team-subscribe, success-verify}) need two things from the request:
//
//   1) A usable public origin for building the successUrl / cancelUrl
//      passed to `createCheckoutSession` (and the returnUrl passed to
//      the billing-portal proxy). `new URL(req.url).origin` is wrong
//      behind Polsia's proxy — that's the INTERNAL bind host. The
//      Origin header → forwarded host → configured URL fallback keeps
//      the redirect landing on the deployed origin.
//
//   2) An Origin / sec-fetch-site allowlist so a cross-site form post
//      (the cheap CSRF primitive) can't start a checkout session on
//      behalf of a signed-out or wrong-account user. Browsers reliably
//      attach `Origin` to POSTs from a "real" navigation; a script that
//      builds the request itself can spoof the header but the same-origin
//      policy will then strip cookies — the CSRF defence is layered.
//
// Three routes had a duplicated `resolveOrigin` already; this file keeps
// that helper and adds `isBrowserNavigationOrigin` as the shared gate.
// The financial-POST allowlist matches NEXT_PUBLIC_APP_URL (single-app
// deploys) and any localhost variants required by local dev.

import { env } from '@/lib/env';

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolves the public origin of the current request — same precedence
 * the legacy `tier-subscribe`/`team-subscribe`/`team-cancel` routes
 * used inline:
 *   1. Origin header (most reliable when present)
 *   2. x-forwarded-host / host, with x-forwarded-proto when present
 *   3. NEXT_PUBLIC_APP_URL fallback (deploy default)
 *
 * Returns null when every fallback is empty so callers can detect
 * "no resolvable origin" without sniffing empty strings.
 */
export function resolveRequestOrigin(req: Request): string | null {
  const fromOrigin = normalize(req.headers.get('origin'));
  if (fromOrigin) return fromOrigin;

  const hostHeader = normalize(req.headers.get('x-forwarded-host') ?? req.headers.get('host'));
  if (hostHeader) {
    const protoRaw = req.headers.get('x-forwarded-proto');
    const proto = protoRaw?.includes('https') ? 'https' : 'http';
    return `${proto}://${hostHeader}`;
  }

  return normalize(env.NEXT_PUBLIC_APP_URL);
}

// Trusted origin set for billing POSTs — the production app URL plus
// any configured localhost variants needed by the dev environment.
// Origin allowlist is the cheap, browser-attached CSRF primitive: a
// cross-site POST from an attacker's page is rejected because its
// Origin header doesn't match.
function buildOriginAllowlist(): { exact: string[]; devPatterns: RegExp[] } {
  const exact = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    const value = raw?.trim().replace(/\/+$/, '');
    if (!value) return;
    try {
      const parsed = new URL(value);
      exact.add(`${parsed.protocol}//${parsed.host}`);
    } catch {
      // ignore — env var was malformed
    }
  };
  add(env.NEXT_PUBLIC_APP_URL);
  // Wildcards are deliberately NOT used in production. Dev-only loopback
  // ports (Mac/Linux dev servers may bind 3000, 3001, 80, etc.) match a
  // host pattern never true in production.
  const devPatterns: RegExp[] = [];
  if (env.NODE_ENV !== 'production') {
    devPatterns.push(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  }
  return { exact: Array.from(exact), devPatterns };
}

const ALLOWLIST = buildOriginAllowlist();

/**
 * Returns true when the request's `Origin` (or `Referer` as a fallback)
 * is in the trusted set, OR when the browser nav signals are absent AND
 * the request is a server-to-server call (no Origin, sec-fetch-site:none).
 *
 * Browser-attached navigation POSTs always include `Origin`. The
 * `sec-fetch-site` header when present tells us:
 *   "same-origin" → safe
 *   "cross-site"  → reject (CSRF-shaped)
 *   "none"        → server-to-server or unusual client; allow on
 *                   next-hop verification (auth/cookie required).
 */
export function isBrowserNavigationOriginTrusted(req: Request): boolean {
  const origin = resolveRequestOrigin(req);
  if (!origin) {
    return false;
  }
  if (ALLOWLIST.exact.includes(origin)) {
    return true;
  }
  if (ALLOWLIST.devPatterns.some((p) => p.test(origin))) {
    return true;
  }
  return false;
}

/**
 * Public helper for the successUrl / cancelUrl / returnUrl builders:
 * ALWAYS non-null, falling back to NEXT_PUBLIC_APP_URL when neither
 * Origin nor forwarded headers resolved.
 */
export function resolveRequestOriginStrict(req: Request): string {
  return resolveRequestOrigin(req) ?? env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}
