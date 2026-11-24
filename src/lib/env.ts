// @polsia:shared — edit only through declared slots. Code installed by polsia/template-next@0.3.0.
//
// Typed env via @t3-oss/env-nextjs.
//
// Modules contribute env vars via their manifest `contributions` block.
// The installer regenerates this file's slots between the markers below.
// Hand-editing outside those slots is rejected by the ownership validator.
//
// The `no-secrets-in-client-bundle` validator scans the build output and rejects
// the install if any non-NEXT_PUBLIC_ env name appears in client chunks.

import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // D24: Prisma is the framework-native DB client. DATABASE_URL is
    // injected by Polsia at deploy time (D23). The actual Postgres is
    // provisioned by a separate Polsia service; this module ships the
    // client only.
    DATABASE_URL: z.string().url(),
    // @polsia:slot env_vars_server start
    // Optional NVD API key — when set, the scanner upgrades from keyless
    // public rate limits (6 req / 30s) to the elevated pool. Never required:
    // the route falls back to the keyless path when absent.
    NVD_API_KEY: z.string().optional(),
    // Static shared-secret for /api/v1/** enterprise endpoints. When unset, the
    // handlers fail closed with 503 api_key_not_configured rather than 401-ing
    // every caller; rotation is a redeploy.
    VULN_API_KEY: z.string().min(1).optional(),
    // Modules append additional server-side env vars here at install time.
    // @polsia:contrib better-auth start
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url(),
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    POLSIA_OWNER_EMAIL: z.string().optional(),
    POLSIA_GOOGLE_SIGNIN_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_SIGNIN_CLIENT_SECRET: z.string().min(1).optional(),
    // @polsia:contrib better-auth end
    // Default AWS region used by STS assume-role calls when a connection does
    // not pin one. Per-connection regions live in DB; this is the fallback.
    AWS_REGION: z.string().default('us-east-1'),
    // Azure discovery — FALLBACK identity for the connection-test probe when a
    // connection row stores it. Stored customer credentials win per-row.
    AZURE_TENANT_ID: z.string().optional(),
    AZURE_CLIENT_ID: z.string().optional(),
    // GCP discovery — federated workload-identity fallback. If unset, customers
    // must supply a service-account JSON per connection row.
    GCP_PROJECT_FALLBACK: z.string().optional(),
    // AES-256-GCM key for envelope-encrypting webhook signing secrets at rest.
    // Generated once at first boot when absent (dev/test fallback); production
    // deployments must supply a stable 64-char hex value so ciphertext doesn't
    // mutate between restarts.
    WEBHOOK_SIGNING_KEY: z.string().min(1).optional(),
    // Per-team sliding-window rate limits for /api/v1/*. Defaults match the
    // documented contract (60 read / 20 write / 10 tighter per minute).
    // Setting RATE_LIMIT_ENABLED=false keeps the response shape (headers
    // still attached) but skips the bucket upsert — useful for staging.
    RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true'),
    RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_TIGHTER_PER_MIN: z.coerce.number().int().positive().default(10),
    // VosnCheck API key — required for the live vulns-vulncheck-api endpoint.
    // Optional so the cron degrades gracefully to the (smaller) public index.
    // When unset, the VulnCheck client returns the empty map on every call.
    VULNCHECK_API_TOKEN: z.string().optional(),
    // Live intel poll cadences (ms) — cron ticks are coarse (15m), but each
    // FEtch+rescore is gated by a per-feed interval so EPSS (1h) and
    // VulnCheck (5m) re-derive when their own clock is up regardless of the
    // cron scheduling. Defaults match the documented contract.
    THREAT_INTEL_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
    THREAT_INTEL_EPSS_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60_000),
    THREAT_INTEL_VULNCHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
    // @polsia:contrib email start
    POLSIA_EMAIL_PROXY_URL: z.string().url(),
    POLSIA_COMPANY_EMAIL: z.string().optional(),
    // @polsia:contrib email end
    // Self-serve trial workspace scaffolding. TRIAL_DURATION_DAYS drives the
    // trial ledger (default 14 days, no credit card). TRIAL_SAMPLE_TARGET_HOST
    // is the deterministic hostname the seed populates so the dashboard
    // renders populated at /trial/started. EMAIL_FROM_TRIAL is the sender the
    // welcome + expiry trail uses; consumed by the email module so reminders
    // have a coherent from-address.
    TRIAL_DURATION_DAYS: z.coerce.number().int().positive().default(14),
    TRIAL_SAMPLE_TARGET_HOST: z.string().default('acme-sample.vulnaware.app'),
    EMAIL_FROM_TRIAL: z.string().default('VulnAware Trials <trials@vulnaware.app>'),
    // Per-category sender identity for outbound email. Defaults map to the
    // verified transactional domain vulnaware.com; runtime values are injected
    // by the deploy injector (D23) once the operator verifies SPF/DKIM/DMARC at
    // Cloudflare and registers the domain with the Polsia email proxy.
    EMAIL_FROM_ALERTS: z.string().default('VulnAware Alerts <alerts@vulnaware.com>'),
    EMAIL_FROM_VULN: z.string().default('VulnAware Notifications <notifications@vulnaware.com>'),
    EMAIL_FROM_INVITES: z.string().default('VulnAware Team <team@vulnaware.com>'),
    EMAIL_FROM_DIGEST: z.string().default('VulnAware Digest <digest@vulnaware.com>'),
    // Trial-funnel A/B labelling for the dashboard cloud-connection nudge.
    // TRIAL_COHORT gates whether the nudge renders for a given build;
    // TRIAL_EXPERIMENT is the experiment label the client island tags
    // every nudge-interaction funnel row with. Both are bounded so a
    // bad env can't ship unbounded strings into the funnel log.
    TRIAL_COHORT: z.enum(['control', 'nudge_v1']).default('control'),
    TRIAL_EXPERIMENT: z.string().min(1).max(64).default('cloud_nudge_v0'),
    // Brand identity — single source of truth driven by @/lib/brand.ts.
    // These flow into siteName/siteDescription/brandVisual + every
    // customer-facing literal across pages, emails, and the PDF footer.
    // Defaults match the current deployed identity so an unset env is
    // byte-equivalent to the live app.
    BRAND_NAME: z.string().min(1).default('VulnAware'),
    BRAND_TAGLINE: z
      .string()
      .min(1)
      .default('24/7 vulnerability intelligence for modern enterprise.'),
    BRAND_LOGO_URL: z.string().url().optional(),
    BRAND_PRIMARY_COLOR: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#1f8f7a'),
    BRAND_DOMAIN: z.string().min(1).default('vulnaware.app'),
    BRAND_FROM_EMAIL: z.string().email().default('vulnaware@polsia.app'),
    // Bearer-token gate for GET /api/ci/webhook. Single-workspace fallback
    // when the deploy owns one Team; the multi-workspace deploys use the
    // JSON map below. Optional so a fresh clone validates; the route
    // surfaces 503 ci_webhook_token_not_configured when neither env var
    // nor a DB row is wired.
    CI_WEBHOOK_TOKEN: z.string().min(1).optional(),
    // Per-team JSON map: { "<teamName>": { "teamId": "<id>", "token":
    // "<plaintext>" } }. Used by multi-workspace deploys to map a bearer
    // token directly to its team. Validated lazily (inside the lookup
    // helper) so a stale JSON doesn't fail the deploy — bad JSON surfaces
    // as 503 at request time instead.
    CI_WEBHOOK_TOKENS_JSON: z.string().optional(),
    // @polsia:contrib ai start
    POLSIA_AI_BASE_URL: z.string().url().default('https://polsia.com/ai/openai/v1'),
    // @polsia:contrib ai end
    // @polsia:contrib stripe-billing start
    POLSIA_API_BASE_URL: z.string().url().default('https://polsia.com'),
    POLSIA_API_KEY: z.string().min(1).optional(),
    POLSIA_API_TOKEN: z.string().min(1).optional(),
    // @polsia:contrib stripe-billing end
    // @polsia:slot env_vars_server end
  },

  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    // Base for @/lib/api-client + proxy.ts connect-src. Default-empty
    // (unset) means same-origin `/api`; set only for an external API origin.
    NEXT_PUBLIC_API_URL: z.string().url().optional(),
    // @polsia:slot env_vars_client start
    // Client-visible mirror of TRIAL_COHORT / TRIAL_EXPERIMENT. Optional
    // so a dev/staging build without an A/B assignment still validates;
    // the island then derives a deterministic cohort from the userId hash
    // so dev never sees a 100% nudge cohort. The cohort is allowed to be
    // public (it shows up in the rendered nudge markup) and there's no
    // privacy concern with leakage here.
    NEXT_PUBLIC_TRIAL_COHORT: z.enum(['control', 'nudge_v1']).optional(),
    NEXT_PUBLIC_TRIAL_EXPERIMENT: z.string().min(1).max(64).optional(),
    // Client-visible mirrors of the BRAND_* server vars. The @t3-oss/env
    // proxy throws when a client bundle reads a server-only key
    // ("BAD_VAR_NAME is not available on the client"), which collapses every
    // route's hydration in Chrome/Edge via the root error.tsx boundary.
    // All optional so a deploy without them still validates — defaults stay
    // on the server keys (byte-equivalent to the live VulnAware identity).
    NEXT_PUBLIC_BRAND_NAME: z.string().min(1).optional(),
    NEXT_PUBLIC_BRAND_TAGLINE: z.string().min(1).optional(),
    NEXT_PUBLIC_BRAND_LOGO_URL: z.string().url().optional(),
    NEXT_PUBLIC_BRAND_PRIMARY_COLOR: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    NEXT_PUBLIC_BRAND_DOMAIN: z.string().min(1).optional(),
    NEXT_PUBLIC_BRAND_FROM_EMAIL: z.string().email().optional(),
    // Modules append NEXT_PUBLIC_* env vars here at install time.
    // @polsia:contrib better-auth start
    NEXT_PUBLIC_POLSIA_GOOGLE_SIGNIN: z.string().optional(),
    NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID: z.string().min(1).optional(),
    // @polsia:contrib better-auth end
    // @polsia:slot env_vars_client end
  },

  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    // @polsia:slot env_runtime start
    NVD_API_KEY: process.env.NVD_API_KEY,
    VULN_API_KEY: process.env.VULN_API_KEY,
    // Modules append runtime-env entries here at install time.
    // @polsia:contrib better-auth start
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    POLSIA_OWNER_EMAIL: process.env.POLSIA_OWNER_EMAIL,
    POLSIA_GOOGLE_SIGNIN_CLIENT_ID: process.env.POLSIA_GOOGLE_SIGNIN_CLIENT_ID,
    GOOGLE_SIGNIN_CLIENT_SECRET: process.env.GOOGLE_SIGNIN_CLIENT_SECRET,
    NEXT_PUBLIC_POLSIA_GOOGLE_SIGNIN: process.env.NEXT_PUBLIC_POLSIA_GOOGLE_SIGNIN,
    NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID,
    // @polsia:contrib better-auth end
    AWS_REGION: process.env.AWS_REGION,
    AZURE_TENANT_ID: process.env.AZURE_TENANT_ID,
    AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
    GCP_PROJECT_FALLBACK: process.env.GCP_PROJECT_FALLBACK,
    WEBHOOK_SIGNING_KEY: process.env.WEBHOOK_SIGNING_KEY,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    RATE_LIMIT_READ_PER_MIN: process.env.RATE_LIMIT_READ_PER_MIN,
    RATE_LIMIT_WRITE_PER_MIN: process.env.RATE_LIMIT_WRITE_PER_MIN,
    RATE_LIMIT_TIGHTER_PER_MIN: process.env.RATE_LIMIT_TIGHTER_PER_MIN,
    VULNCHECK_API_TOKEN: process.env.VULNCHECK_API_TOKEN,
    THREAT_INTEL_POLL_INTERVAL_MS: process.env.THREAT_INTEL_POLL_INTERVAL_MS,
    THREAT_INTEL_EPSS_INTERVAL_MS: process.env.THREAT_INTEL_EPSS_INTERVAL_MS,
    THREAT_INTEL_VULNCHECK_INTERVAL_MS: process.env.THREAT_INTEL_VULNCHECK_INTERVAL_MS,
    // @polsia:contrib email start
    POLSIA_EMAIL_PROXY_URL: process.env.POLSIA_EMAIL_PROXY_URL,
    POLSIA_COMPANY_EMAIL: process.env.POLSIA_COMPANY_EMAIL,
    // @polsia:contrib email end
    TRIAL_DURATION_DAYS: process.env.TRIAL_DURATION_DAYS,
    TRIAL_SAMPLE_TARGET_HOST: process.env.TRIAL_SAMPLE_TARGET_HOST,
    EMAIL_FROM_TRIAL: process.env.EMAIL_FROM_TRIAL,
    EMAIL_FROM_ALERTS: process.env.EMAIL_FROM_ALERTS,
    EMAIL_FROM_VULN: process.env.EMAIL_FROM_VULN,
    EMAIL_FROM_INVITES: process.env.EMAIL_FROM_INVITES,
    EMAIL_FROM_DIGEST: process.env.EMAIL_FROM_DIGEST,
    TRIAL_COHORT: process.env.TRIAL_COHORT,
    TRIAL_EXPERIMENT: process.env.TRIAL_EXPERIMENT,
    NEXT_PUBLIC_TRIAL_COHORT: process.env.NEXT_PUBLIC_TRIAL_COHORT,
    NEXT_PUBLIC_TRIAL_EXPERIMENT: process.env.NEXT_PUBLIC_TRIAL_EXPERIMENT,
    NEXT_PUBLIC_BRAND_NAME: process.env.NEXT_PUBLIC_BRAND_NAME,
    NEXT_PUBLIC_BRAND_TAGLINE: process.env.NEXT_PUBLIC_BRAND_TAGLINE,
    NEXT_PUBLIC_BRAND_LOGO_URL: process.env.NEXT_PUBLIC_BRAND_LOGO_URL,
    NEXT_PUBLIC_BRAND_PRIMARY_COLOR: process.env.NEXT_PUBLIC_BRAND_PRIMARY_COLOR,
    NEXT_PUBLIC_BRAND_DOMAIN: process.env.NEXT_PUBLIC_BRAND_DOMAIN,
    NEXT_PUBLIC_BRAND_FROM_EMAIL: process.env.NEXT_PUBLIC_BRAND_FROM_EMAIL,
    BRAND_NAME: process.env.BRAND_NAME,
    BRAND_TAGLINE: process.env.BRAND_TAGLINE,
    BRAND_LOGO_URL: process.env.BRAND_LOGO_URL,
    BRAND_PRIMARY_COLOR: process.env.BRAND_PRIMARY_COLOR,
    BRAND_DOMAIN: process.env.BRAND_DOMAIN,
    BRAND_FROM_EMAIL: process.env.BRAND_FROM_EMAIL,
    CI_WEBHOOK_TOKEN: process.env.CI_WEBHOOK_TOKEN,
    CI_WEBHOOK_TOKENS_JSON: process.env.CI_WEBHOOK_TOKENS_JSON,
    // @polsia:contrib ai start
    POLSIA_AI_BASE_URL: process.env.POLSIA_AI_BASE_URL,
    // @polsia:contrib ai end
    // @polsia:contrib stripe-billing start
    POLSIA_API_BASE_URL: process.env.POLSIA_API_BASE_URL,
    POLSIA_API_KEY: process.env.POLSIA_API_KEY,
    POLSIA_API_TOKEN: process.env.POLSIA_API_TOKEN,
    // @polsia:contrib stripe-billing end
    // @polsia:slot env_runtime end
  },
  emptyStringAsUndefined: true,
  // SKIP_ENV_VALIDATION=1 bypasses validation for envless builds (lint/CI/local).
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
