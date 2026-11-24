// @polsia:user-owned — brand identity. Edit freely. `site.ts` re-exports
// siteName/siteDescription; `manifest.ts` + `opengraph-image.tsx` read `brandVisual`.
//
// Driven by six BRAND_* env vars (defaults match the current deployed
// identity so an unset env is byte-equivalent). The `brand` const is the
// single source of truth — page metadata, body copy, OG/Twitter, email
// templates, and the PDF footer all read from it.

import { env } from '@/lib/env';

// Read NEXT_PUBLIC_BRAND_* mirrors first so client bundles (which only see
// client-schema keys via @t3-oss/env-nextjs) get the right value. Fall through
// to the BRAND_* server keys via raw `process.env.X` reads — NOT through the
// t3 proxy — because the proxy throws "BRAND_NAME is not available on the
// client" at module init whenever a client bundle asks it for a server-only
// key, which collapses every route's hydration into global-error.tsx. Next.js
// inlines server-only `process.env.BRAND_*` reads as `undefined` in client
// bundles, so this fallback is dead code on the client and the literal
// defaults below keep the client identity byte-equivalent to the server.
const serverBrandName = process.env.BRAND_NAME ?? 'VulnAware';
const serverBrandTagline =
  process.env.BRAND_TAGLINE ?? '24/7 vulnerability intelligence for modern enterprise.';
const serverBrandLogoUrl = process.env.BRAND_LOGO_URL;
const serverBrandPrimaryColor = process.env.BRAND_PRIMARY_COLOR ?? '#1f8f7a';
const serverBrandDomain = process.env.BRAND_DOMAIN ?? 'vulnaware.app';
const serverBrandFromEmail = process.env.BRAND_FROM_EMAIL ?? 'vulnaware@polsia.app';

export const brand = {
  name: env.NEXT_PUBLIC_BRAND_NAME ?? serverBrandName,
  tagline: env.NEXT_PUBLIC_BRAND_TAGLINE ?? serverBrandTagline,
  /** Optional hosted logo URL — empty by default; OG image stays file-based. */
  logoUrl: env.NEXT_PUBLIC_BRAND_LOGO_URL ?? serverBrandLogoUrl ?? null,
  primaryColor: env.NEXT_PUBLIC_BRAND_PRIMARY_COLOR ?? serverBrandPrimaryColor,
  domain: env.NEXT_PUBLIC_BRAND_DOMAIN ?? serverBrandDomain,
  contactEmail: env.NEXT_PUBLIC_BRAND_FROM_EMAIL ?? serverBrandFromEmail,
} as const;

export const siteName = brand.name;
export const siteDescription =
  'AI-driven 24/7 vulnerability scanning, risk prioritization, and remediation automation for modern enterprise security teams and DevSecOps pipelines.';

// PWA + social-share colors. HEX only (the oklch() tokens in globals.css aren't
// readable here) — set to match your brand seed.
export const brandVisual = {
  /** PWA browser-UI / status-bar color. */
  themeColor: brand.primaryColor,
  /** PWA splash + install background. */
  backgroundColor: '#0a1313',
  /** Social-share (OG/Twitter) image. */
  og: {
    background: '#0a1313',
    foreground: '#e9f5f2',
    /** Second line under the site name; '' hides it. */
    tagline: brand.tagline,
  },
} as const;
