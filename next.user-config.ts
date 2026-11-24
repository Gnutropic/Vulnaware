// @polsia:user-owned — your Next.js customizations, merged into next.config.ts by the
// framework. Edit freely (no slot markers). next.config.ts stays framework-owned: don't
// put security headers / CSP / a full `images` block here.
import type { NextConfig } from 'next';
import type { CspExtraSources } from './src/lib/csp';
import type { AppCapabilities } from './src/lib/permissions-policy';

type RemotePatterns = NonNullable<NonNullable<NextConfig['images']>['remotePatterns']>;

/** Remote hosts you load <Image> from. e.g. { protocol: 'https', hostname: 'images.unsplash.com' } */
export const userRemotePatterns: RemotePatterns = [];

/**
 * Package-level Next options (transpilePackages, experimental.optimizePackageImports, …).
 *
 * Externalize `kysely` so the runtime's static-import check never walks
 * kysely's exports when pulling in `@better-auth/kysely-adapter`'s
 * optional SQLite dialect files. Those dialects statically import
 * `DEFAULT_MIGRATION_TABLE` / `DEFAULT_MIGRATION_LOCK_TABLE` from kysely,
 * which were moved to the `kysely/migration` subpath in kysely 0.29 — but
 * this app uses the Prisma adapter and never reaches the SQLite dialect
 * branch, so externalizing kysely cuts the impossible-export check off.
 */
export const userNextConfig: NextConfig = {
  serverExternalPackages: ['kysely'],
  // Pin Next's workspace root to this app. The Polsia harness keeps a
  // runner-side package-lock.json at /opt/polsia-runner for the agent
  // SDK; without this pin, Next's lockfile-detector picks the parent
  // directory as the root, which masquerades as a heavier workspace
  // and exhausts V8's default 2 GB heap during the TypeScript phase.
  // Anchoring here lets next build narrow to the app's own deps.
  outputFileTracingRoot: process.cwd(),
};

export type ConfigPlugin = (config: NextConfig) => NextConfig;

/**
 * Next plugins that must WRAP the whole config (next-intl, Sentry, MDX,
 * bundle-analyzer). Each entry is a `(config) => config` wrapper — pre-bind
 * options. next.config.ts applies these and re-asserts the security headers
 * afterward, so a plugin can extend the build but never drop the day-1 posture.
 * For i18n, install the `i18n` module and add its plugin here per its AGENT.md.
 *
 *   export const userConfigPlugins: ConfigPlugin[] = [
 *     createNextIntlPlugin('./src/i18n/request.ts'),
 *     (config) => withSentryConfig(config, { silent: true }),
 *   ];
 */
export const userConfigPlugins: ConfigPlugin[] = [];

/**
 * Extra CSP source allow-lists (frame/connect/media/font/img). Appended to
 * those resource directives only — script-src/style-src stay strict.
 * Default empty: the strict baseline lists `'self'` and the policy's hard-coded
 * image/connect origins, so most apps need nothing here. ONLY token-level
 * additions go in this seam; the validator drops wildcards/'unsafe-*' so
 * adding them here is a silent no-op.
 */
export const cspExtraSources: CspExtraSources = {
  // VulnCheck NVD-CVE index — the cron + on-demand rescore both fetch from
  // api.vulncheck.test in dev (sandbox host) and api.vulncheck.com in prod.
  connectSrc: ['https://api.vulncheck.com', 'https://api.vulncheck.test'],
};

/**
 * Browser capabilities the app actually uses. Each `true` flips the matching
 * Permissions-Policy directive to `(self)` — `(self)` only lets THIS origin
 * *request* the feature; the browser's native permission prompt is still the
 * real gate, so opting in is low-risk. Keep unused features OFF: declared
 * unused device permissions dervice nothing and are flagged in audits.
 *
 *   export const appCapabilities: AppCapabilities = {
 *     microphone: true,  // voice recording
 *     camera: true,      // video calls, QR scan
 *     geolocation: true, // "near me" search, maps
 *   };
 */
export const appCapabilities: AppCapabilities = {};
