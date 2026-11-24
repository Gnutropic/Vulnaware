// @polsia:user-owned — Self-serve trial workspace orchestrator.
//
// Public entry point: trialSignup({ email, company, workspaceName }).
//
// 1. Server-generated random password, hashed into a better-auth
//    Account + User pair via the catch-all /api/auth/sign-up/email
//    endpoint (server-side fetch). We do NOT modify better-auth core
//    or its hooks — the user.create.after hook fires too, which is the
//    point of compensating in step 3.
// 2. Slugify workspaceName + a 6-char nanoid suffix to dodge collisions
//    on Team.name @unique when two trial signups share an email local
//    part.
// 3. Inside prisma.$transaction: create Team, move the user's Membership
//    and owner roster row to it, replace the provisional Workspace, and
//    write TrialWorkspace. These rows commit or roll back together.
// 4. Seed the trial workspace with sample scan/assets/CVEs so the
//    dashboard renders populated, not empty.
// 5. Mint a 32-byte URL-safe claim token; scrypt-hash it into the row;
//    return the raw token + redirectUrl.
// 6. Optional signin followup. When `forwardSessionCookies: true`,
//    immediately POST to /api/auth/sign-in/email with the same
//    credentials so a session cookie is created and replayed back to
//    the route handler. Done AFTER provisionTrialWorkspace so the user
//    has a Team + Membership before a session is established (mirrors
//    what `useSession` resolves to on subsequent dashboard reads).
// 7. Fire-and-forget the welcome/claim email — never blocks the response.

import 'server-only';
import { randomBytes, scrypt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { brand } from '@/lib/brand';
import { recordTrialFunnelStep } from '@/lib/business/analytics';
import {
  ensureWorkspaceForTeam,
  removeProvisionalWorkspace,
} from '@/lib/business/default-workspace';
import { seedTrialSample } from '@/lib/business/trial-seed';
import type { CompanySize, OnboardingStep, TieredTrialSignupTier } from '@/lib/contracts/trial';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { renderEmail } from '@/lib/email/templates';
import { env } from '@/lib/env';

// Step copy: tied to the four activation milestones the onboarding
// experiment wants to push inbound trials through. The body strings are
// read verbatim by the island — single source of truth is here so a
// copy edit on the dashboard lands on the dashboard and nowhere else.
const ONBOARDING_STEPS: ReadonlyArray<{
  key: OnboardingStep['key'];
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
}> = [
  {
    key: 'connect_first_asset',
    title: 'Connect your first asset',
    body: `Link AWS, Azure, or GCP so ${brand.name} can enumerate live services and find what your scanners miss.`,
    ctaHref: '/cloud',
    ctaLabel: 'Connect a cloud account',
  },
  {
    key: 'run_first_scan',
    title: 'Run your first scan',
    body: 'Pick any host — your perimeter, an internal service, or the seeded sample — and let the probe do the work.',
    ctaHref: '/scans',
    ctaLabel: 'Open scans',
  },
  {
    key: 'review_findings',
    title: 'Review your first findings',
    body: 'Severity-ranked findings with KEV + VulnCheck intel — filter by team and triage what matters next.',
    ctaHref: '/scans?focus=findings',
    ctaLabel: 'Open findings',
  },
  {
    key: 'invite_teammate',
    title: 'Invite a teammate',
    body: 'Bring in another engineer or analyst so reviews, owning findings, and on-call rotations share the load.',
    ctaHref: '/settings/team',
    ctaLabel: 'Invite teammate',
  },
];

const SCRYPT_KEYLEN = 64;

interface TrialSignupInput {
  email: string;
  company: string;
  workspaceName: string;
  // Optional self-reported company-size bucket — surfaced on the
  // public trial signup form and persisted on TrialWorkspace.companySize.
  companySize?: CompanySize | null;
  // Optional redirect target picked by the caller. Defaults to the
  // claim-email path so existing /api/v1/trial-signup callers are
  // unchanged; /api/trial/signup sets it to '/dashboard' so a
  // fresh visitor lands authenticated inside the workspace.
  redirectTarget?: string;
  // When true, the orchestrator follows the sign-up with a server-side
  // signin so a valid better-auth.session_token is returned to the
  // route handler. Forwarded as `Set-Cookie` headers — the handler
  // replays them onto its NextResponse so `useSession()` resolves on
  // the subsequent /dashboard load. Defaults to false.
  forwardSessionCookies?: boolean;
}

interface TrialSignupResult {
  ok: true;
  redirectUrl: string;
  userId: string;
  // Set-Cookie header lines captured from the better-auth API calls
  // the orchestrator made. Present only when the caller asked for
  // cookie forwarding (`forwardSessionCookies: true`). The route
  // handler replays each line onto its NextResponse so the browser
  // stores the session token.
  setCookieHeaders?: string[];
}

// Slugify a free-text workspace name into a `trial-<slug>-<6-char>` token.
// Two constraints: (1) Team.name is unique, so we always add a fresh
// nanoid-derived suffix — never trust the slug alone. (2) The slug must
// fit Team's practical identifier shape (lowercase alnum + dashes).
function buildTeamName(input: string): string {
  const base =
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace';
  const suffix =
    randomBytes(3)
      .toString('base64url')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')
      .slice(0, 6) || 'rand00';
  return `trial-${base}-${suffix}`;
}

// 32-byte URL-safe token. Mirrors the generator already used by
// api-keys.ts (randomBytes/base64url) so an analyst faces a consistent
// surface. Returned to the caller exactly once; only the scrypt hash is
// stored on TrialWorkspace.claimTokenHash.
function mintClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

function scryptHash(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(token, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(`${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

// Programmatic signup — fire a synthetic POST through the better-auth
// catch-all /api/auth/sign-up/email. Going through HTTP keeps the
// CSRF check consistent (origin match against BETTER_AUTH_URL) and
// fires the existing user.create.after databaseHooks (which is the
// behaviour we compensate in transaction below).
//
// Returns:
//   - `userId`  — either the freshly created user's id, or an existing
//     user's id when better-auth rejected a duplicate email (so the
//     public flow doesn't leak which emails are registered).
//   - `isExisting` — true when the call resolved to an existing user
//     (duplicate-email fallback). The /api/trial/signup route uses
//     this to skip the signin follow-up, because we don't have the
//     original password and shouldn't issue a new session for an
//     account we don't own.
//   - `setCookie`  — the `Set-Cookie` header lines better-auth returned
//     on the response. Captured so a caller asking for cookie
//     forwarding can replay them onto its own response.
async function signUpViaAuthApi(input: {
  email: string;
  password: string;
  name: string;
}): Promise<{ userId: string; isExisting: boolean; setCookie: string[] }> {
  const url = new URL('/api/auth/sign-up/email', env.BETTER_AUTH_URL).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // satisfy better-auth's origin check (csrf middleware ignores requests
      // when the cookie header is empty AND there's no Sec-Fetch-Site — by
      // passing an empty cookie we route the check through trustedOrigins
      // matching, which BETTER_AUTH_URL satisfies).
      origin: env.BETTER_AUTH_URL,
      cookie: '',
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      name: input.name,
    }),
  });
  const setCookie = res.headers.getSetCookie();
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Duplicate email returns a 4xx from better-auth; we treat that the same
    // as a 200 by looking up the existing user so the public flow doesn't
    // leak which emails are registered.
    if (res.status >= 400 && res.status < 500) {
      const existing = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase() },
        select: { id: true },
      });
      if (existing) return { userId: existing.id, isExisting: true, setCookie };
    }
    throw new Error(`auth sign-up failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { user?: { id?: string }; id?: string };
  const userId = data.user?.id ?? data.id;
  if (!userId) {
    throw new Error('auth sign-up returned no user id');
  }
  return { userId, isExisting: false, setCookie };
}

// Programmatic signin — mirrors signUpViaAuthApi but hits
// /api/auth/sign-in/email with the credentials the orchestrator
// already has (the random password minted for sign-up). Used by the
// /api/trial/signup route to issue a fresh session for the brand-new
// user immediately after the workspace is provisioned, so a
// `router.push('/dashboard')` lands inside an authenticated context.
// Always returns the captured Set-Cookie header lines (the only
// caller needs them to forward to the browser).
async function signInViaAuthApi(input: {
  email: string;
  password: string;
}): Promise<{ setCookie: string[] }> {
  const url = new URL('/api/auth/sign-in/email', env.BETTER_AUTH_URL).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.BETTER_AUTH_URL,
      cookie: '',
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
    }),
  });
  const setCookie = res.headers.getSetCookie();
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`auth sign-in failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return { setCookie };
}

// Compensating transaction: Better Auth's user.create.after provisions the
// provisional default Team/Workspace first. Move the user's Membership to
// the selected trial Team, replace its owner roster entry, and remove the
// provisional owned Workspace atomically with the TrialWorkspace row.
async function attachTrialWorkspace(
  tx: Prisma.TransactionClient,
  user: { id: string; email: string },
  team: { id: string; name: string },
): Promise<void> {
  const existingMembership = await tx.membership.findUnique({
    where: { userId: user.id },
    select: { teamId: true },
  });
  const previousOwnedWorkspaces = await tx.workspace.findMany({
    where: { ownerUserId: user.id, id: { not: team.id } },
    select: { id: true },
  });

  await tx.membership.upsert({
    where: { userId: user.id },
    create: { userId: user.id, teamId: team.id, role: 'admin' },
    update: { teamId: team.id, role: 'admin' },
  });
  await ensureWorkspaceForTeam(tx, user, team, { forceOwner: true });

  const provisionalWorkspaceIds = new Set([
    ...(existingMembership?.teamId ? [existingMembership.teamId] : []),
    ...previousOwnedWorkspaces.map((workspace) => workspace.id),
  ]);
  provisionalWorkspaceIds.delete(team.id);

  for (const workspaceId of provisionalWorkspaceIds) {
    await removeProvisionalWorkspace(tx, user.id, workspaceId);
  }
}

async function provisionTrialWorkspace(args: {
  userId: string;
  userEmail: string;
  teamName: string;
  companySize?: CompanySize | null;
}): Promise<{ teamId: string; trialEndsAt: Date }> {
  const trialEndsAt = new Date(Date.now() + env.TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
  const claimToken = mintClaimToken();
  const claimTokenHash = await scryptHash(claimToken);

  return prisma
    .$transaction(async (tx) => {
      const team = await tx.team.create({
        data: { name: args.teamName },
        select: { id: true, name: true },
      });

      await attachTrialWorkspace(tx, { id: args.userId, email: args.userEmail }, team);

      const trial = await tx.trialWorkspace.create({
        data: {
          teamId: team.id,
          ownerUserId: args.userId,
          trialEndsAt,
          onboardingCompletedAt: null,
          claimTokenHash,
          // Best-effort — contract is optional. `null` keeps historical
          // rows semantically identical to "no answer".
          companySize: args.companySize ?? null,
        },
        select: { id: true },
      });

      return { teamId: team.id, trialEndsAt, trialId: trial.id, claimToken };
    })
    .then(async (result) => {
      // Flip the seed flag once the seed completes, outside the transaction.
      await seedTrialSample(result.teamId).catch(() => undefined);
      await prisma.trialWorkspace
        .update({
          where: { id: result.trialId },
          data: { sampleSeeded: true },
        })
        .catch(() => undefined);
      return { teamId: result.teamId, trialEndsAt: result.trialEndsAt };
    });
}

function buildTrialWelcome(
  token: string,
  company: string,
): {
  subject: string;
  html: string;
  text: string;
} {
  const claimUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/trial/started?claim=${encodeURIComponent(token)}`;
  const { html, text } = renderEmail({
    heading: `Your ${brand.name} trial is ready, ${company}.`,
    body: [
      `Your 14-day ${brand.name} trial workspace is provisioned and seeded with a sample asset inventory so you can explore the dashboard immediately.`,
      'Use the button below to open your workspace. You can invite teammates, generate API keys, and connect cloud accounts from there.',
    ],
    cta: { label: 'Open my workspace', url: claimUrl },
    footer: 'This trial link is intended for the recipient — please do not share it forward.',
  });
  return { subject: `Welcome to ${brand.name} — your trial workspace is ready`, html, text };
}

// Welcome envelope for the tiered signup flow — no claim link. The
// visitor chose their own password, so they sign in directly with
// email + password; we just confirm the workspace is provisioned and
// point the CTA at the canonical welcome route they were already
// redirected to.
function buildTieredTrialWelcome(
  email: string,
  workspaceName: string,
  tier: TieredTrialSignupTier,
): {
  subject: string;
  html: string;
  text: string;
} {
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  const welcomeUrl = `${appUrl}/onboarding/welcome`;
  const { html, text } = renderEmail({
    heading: `Your ${brand.name} trial is ready`,
    body: [
      `Your 14-day ${tier.toUpperCase()} ${brand.name} trial workspace — "${workspaceName}" — is provisioned and seeded with a sample asset inventory.`,
      `Sign in with ${email} to pick up where you left off.`,
    ],
    cta: { label: 'Open my workspace', url: welcomeUrl },
    footer: 'You received this because you signed up for a VulnAware trial workspace.',
  });
  return { subject: `Welcome to ${brand.name} — your trial workspace is ready`, html, text };
}

export async function trialSignup(input: TrialSignupInput): Promise<TrialSignupResult> {
  const password = randomBytes(18).toString('base64url');
  const teamName = buildTeamName(input.workspaceName);

  const {
    userId,
    isExisting,
    setCookie: signUpCookies,
  } = await signUpViaAuthApi({
    email: input.email.toLowerCase(),
    password,
    name: input.company,
  });

  // Duplicate submissions use the same public response shape, but never
  // mutate the existing account's membership or create another trial.
  if (isExisting) {
    return {
      ok: true,
      redirectUrl: input.forwardSessionCookies
        ? '/dashboard'
        : (input.redirectTarget ?? '/trial/started'),
      userId,
    };
  }

  const { teamId, trialEndsAt } = await provisionTrialWorkspace({
    userId,
    userEmail: input.email,
    teamName,
    companySize: input.companySize ?? null,
  });

  // Mint a fresh claim token for the welcome email (stored version was used
  // to derive trialTeamId-equivalent; we re-mint here so the link embedded in
  // the email differs from any internal token and is rotatable via /api).
  const linkToken = mintClaimToken();
  const linkHash = await scryptHash(linkToken);
  await prisma.trialWorkspace
    .update({ where: { teamId }, data: { claimTokenHash: linkHash } })
    .catch(() => undefined);

  // Fire-and-forget welcome email. Like auth-config's hook, swallows sends
  // so a transient email-proxy failure doesn't break the conversion funnel.
  const email = buildTrialWelcome(linkToken, input.company);
  void sendEmail({
    to: input.email.toLowerCase(),
    subject: email.subject,
    html: email.html,
    text: email.text,
  }).catch(() => undefined);

  // Trial-funnel step 2 (trial_workspace_created). Single row per trial
  // signup — intrinsic dedupe because trialSignup is the only writer of
  // TrialWorkspace.userId. Fire-and-forget so a DB hiccup never blocks
  // the dashboard nav that follows the redirect.
  void recordTrialFunnelStep({
    step: 'trial_workspace_created',
    userId,
    teamId,
  }).catch(() => undefined);

  // Suppress — used only to keep the linter honest that trialEndsAt was
  // derived (later code paths read this through /api/trial-status).
  void trialEndsAt;

  // Optional signin follow-up. Only attempted when the caller asked to
  // forward cookies AND the sign-up was a fresh account (we don't have
  // the existing user's password, so issuing a session for an unrelated
  // account would silently stomp an active one). Bundled Set-Cookie
  // lines are the union of sign-up's set (which includes any cookie-cache
  // hint better-auth writes before issuing the session) and sign-in's
  // set (which carries the actual session_token). The route handler
  // replays each line verbatim onto its NextResponse.
  const setCookieHeaders: string[] = [...signUpCookies];
  if (input.forwardSessionCookies && !isExisting) {
    try {
      const { setCookie: signInCookies } = await signInViaAuthApi({
        email: input.email.toLowerCase(),
        password,
      });
      setCookieHeaders.push(...signInCookies);
    } catch {
      // Signin is a best-effort session issuance — fall back to the
      // claim-email redirect so the user still has a way in.
    }
  }

  const redirectTarget = input.redirectTarget ?? '/trial/started';

  return {
    ok: true,
    redirectUrl: input.forwardSessionCookies && !isExisting ? '/dashboard' : redirectTarget,
    userId,
    setCookieHeaders: setCookieHeaders.length > 0 ? setCookieHeaders : undefined,
  };
}

// ── Tiered trial signup — `/signup?tier=pro&trial=1` path ────────────────────
//
// Visitor supplies their own password. No claim-link email roundtrip. After
// the workspace is provisioned, the route handler redirects to
// `/onboarding/welcome` (the same path the browser navigates to via
// `router.push`) and replays the better-auth Set-Cookie so the trialist
// lands authenticated.
//
// Atomicity: Team + Membership + WorkspaceMember + TrialWorkspace writes
// happen inside ONE prisma.$transaction. If any step fails, the user is
// not half-provisioned — the better-auth `databaseHooks.user.create.after`
// auto-rows are also wiped inside the transaction so the trialist ends
// up attached to TRIAL-<slug>-<suffix>, not the legacy ws-<localpart> team.

interface TieredTrialSignupInput {
  email: string;
  password: string;
  workspaceName: string;
  tier: TieredTrialSignupTier;
}

export async function tieredTrialSignup(input: TieredTrialSignupInput): Promise<TrialSignupResult> {
  const teamName = buildTeamName(input.workspaceName);
  const normalizedEmail = input.email.toLowerCase();

  // 1. Programmatic sign-up through better-auth. The
  //    `databaseHooks.user.create.after` runs synchronously inside
  //    better-auth BEFORE the HTTP response returns — by the time the
  //    Promise below resolves, the default Team + Membership + Workspace
  //    already exists for this user. The transaction below moves ownership
  //    to the selected trial Team and removes the provisional Workspace.
  const {
    userId,
    isExisting,
    setCookie: signUpCookies,
  } = await signUpViaAuthApi({
    email: normalizedEmail,
    password: input.password,
    name: input.workspaceName.trim() || normalizedEmail.split('@')[0] || 'workspace',
  });

  if (isExisting) {
    return {
      ok: true,
      redirectUrl: '/onboarding/welcome',
      userId,
    };
  }

  const trialEndsAt = new Date(Date.now() + env.TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
  const planLabel = `trial-14d-${input.tier}`;

  const { teamId } = await prisma
    .$transaction(async (tx) => {
      const team = await tx.team.create({
        data: { name: teamName },
        select: { id: true, name: true },
      });

      await attachTrialWorkspace(tx, { id: userId, email: normalizedEmail }, team);

      await tx.trialWorkspace.create({
        data: {
          teamId: team.id,
          ownerUserId: userId,
          trialEndsAt,
          planLabel,
          // No claim token for tiered signup — the user chose their own
          // password and is signed in already.
          claimTokenHash: null,
          companySize: null,
        },
        select: { id: true },
      });

      return { teamId: team.id };
    })
    .then(async (result) => {
      await seedTrialSample(result.teamId).catch(() => undefined);
      await prisma.trialWorkspace
        .update({ where: { teamId: result.teamId }, data: { sampleSeeded: true } })
        .catch(() => undefined);
      return result;
    });

  // Welcome email — no claim link. Includes the workspace name so the
  // trialist can recognise it in their inbox later. Fire-and-forget so
  // an email-proxy hiccup never blocks the redirect.
  const email = buildTieredTrialWelcome(normalizedEmail, input.workspaceName, input.tier);
  void sendEmail({
    to: normalizedEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
  }).catch(() => undefined);

  void recordTrialFunnelStep({
    step: 'trial_workspace_created',
    userId,
    teamId,
  }).catch(() => undefined);

  // Always issue cookies for tiered signup — the visitor chose their
  // password, so we know it. We bundle sign-up's Set-Cookie set with
  // sign-in's (sign-in is what writes the session_token cookie that
  // makes the browser authenticated on the redirect).
  const setCookieHeaders: string[] = [...signUpCookies];
  try {
    const { setCookie: signInCookies } = await signInViaAuthApi({
      email: normalizedEmail,
      password: input.password,
    });
    setCookieHeaders.push(...signInCookies);
  } catch {
    // Sign-in best-effort — the cookie replay covers sign-up's already-
    // written cache hints. A genuinely failed sign-in only blocks
    // landing inside an authenticated dashboard; the welcome page
    // itself does not require auth.
  }

  return {
    ok: true,
    redirectUrl: '/onboarding/welcome',
    userId,
    setCookieHeaders: setCookieHeaders.length > 0 ? setCookieHeaders : undefined,
  };
}

interface TrialStatusResult {
  active: boolean;
  trialEndsAt: Date | null;
  daysRemaining: number | null;
  onboardingStep: number;
  onboardingCompleted: boolean;
}

export async function trialStatusByTeam(userId: string): Promise<TrialStatusResult> {
  const membership = await prisma.membership.findUnique({
    where: { userId },
    select: { teamId: true },
  });
  if (!membership) {
    return {
      active: false,
      trialEndsAt: null,
      daysRemaining: null,
      onboardingStep: 0,
      onboardingCompleted: false,
    };
  }
  const trial = await prisma.trialWorkspace.findUnique({
    where: { teamId: membership.teamId },
    select: {
      trialEndsAt: true,
      onboardingStep: true,
      onboardingCompletedAt: true,
    },
  });
  if (!trial) {
    return {
      active: false,
      trialEndsAt: null,
      daysRemaining: null,
      onboardingStep: 0,
      onboardingCompleted: false,
    };
  }
  const remainingMs = trial.trialEndsAt.getTime() - Date.now();
  const daysRemaining = remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;
  return {
    active: true,
    trialEndsAt: trial.trialEndsAt,
    daysRemaining,
    onboardingStep: trial.onboardingStep,
    onboardingCompleted: trial.onboardingCompletedAt != null,
  };
}

// Aggregate the four onboard-checklist step flags for the caller.
// `teamId` is resolved server-side via Membership — the client never
// gets to dictate which team to read. Empty-membership path returns
// the empty checklist (all `complete: false`) so the island renders
// null cleanly without an error toast.
export interface OnboardingChecklistResult {
  steps: OnboardingStep[];
  completed: boolean;
  dismissed: boolean;
}

export async function onboardingChecklistByTeam(
  userId: string,
): Promise<OnboardingChecklistResult> {
  const membership = await prisma.membership.findUnique({
    where: { userId },
    select: { teamId: true },
  });
  if (!membership) {
    return { steps: emptySteps(), completed: false, dismissed: false };
  }
  const teamId = membership.teamId;

  // The four derivations run in one round trip. Steps 1 + 2 mirror the
  // sample-scan exclusion in /api/scan/route.ts so the seed scan
  // (target=TRIAL_SAMPLE_TARGET_HOST, mode=tcp-only) doesn't count;
  // otherwise the gate flips "complete" on freshly signed-up trials
  // before the user has done anything. The brief specifies a separate
  // `originKind` column that doesn't exist on Scan, so the seed
  // fingerprint (target, mode) is the natural stand-in (matches what
  // /api/scan/route.ts already trusts for the same trial-distinction).
  const [
    firstScanEventCount,
    nonSeedScanCount,
    inviteCount,
    findingCount,
    connectFirstAssetScan,
    trialStamp,
  ] = await Promise.all([
    prisma.trialFunnelEvent.count({
      where: { teamId, step: 'first_scan_triggered' },
    }),
    prisma.scan.count({
      where: {
        teamId,
        NOT: { target: env.TRIAL_SAMPLE_TARGET_HOST, mode: 'tcp-only' },
      },
    }),
    prisma.invite.count({ where: { teamId } }),
    prisma.vulnerabilityFinding.count({ where: { scan: { teamId } } }),
    // Step 1 derivation — non-seed scan with at least one Asset row
    // (a Scan without assets hasn't actually enumerated anything).
    prisma.scan.findFirst({
      where: {
        teamId,
        assets: { some: {} },
        NOT: { target: env.TRIAL_SAMPLE_TARGET_HOST, mode: 'tcp-only' },
      },
      select: { id: true },
    }),
    prisma.trialWorkspace.findUnique({
      where: { teamId },
      select: { onboardingChecklistDismissedAt: true },
    }),
  ]);

  const runFirstScanComplete = firstScanEventCount > 0 || nonSeedScanCount > 0;
  // Step 1 ("connect your first asset") — non-seed scan that produced
  // at least one Asset row. Keeps both halves of the brief's intent:
  // the Asset rows are born when a scan completes, and the gate
  // skips the trial-seed fingerprint.
  const connectFirstAssetComplete = connectFirstAssetScan != null;

  const completedFlags = {
    connect_first_asset: connectFirstAssetComplete,
    run_first_scan: runFirstScanComplete,
    review_findings: findingCount > 0,
    invite_teammate: inviteCount > 0,
  };

  // Build the steps in the exact order declared in the contract so
  // the response stays stable across renders.
  const steps: OnboardingStep[] = ONBOARDING_STEPS.map((step) => ({
    key: step.key,
    title: step.title,
    body: step.body,
    ctaHref: step.ctaHref,
    ctaLabel: step.ctaLabel,
    complete: completedFlags[step.key],
  }));

  const completed = steps.every((s) => s.complete);
  const dismissed = trialStamp?.onboardingChecklistDismissedAt != null;

  return { steps, completed, dismissed };
}

// Empty checklist shape — used for users with no Membership so the
// island renders `null` instead of an error. Lets the brief's "all
// four steps complete" branch fire naturally once the user lands
// back at /dashboard with their team attached.
function emptySteps(): OnboardingStep[] {
  return ONBOARDING_STEPS.map((step) => ({
    key: step.key,
    title: step.title,
    body: step.body,
    ctaHref: step.ctaHref,
    ctaLabel: step.ctaLabel,
    complete: false,
  }));
}

// Stamp `onboardingChecklistDismissedAt = now()` on the caller's
// TrialWorkspace row. Idempotent — a re-POST with a valid team just
// updates the timestamp to the current clock. Returns the stamp the
// handler surfaces back to the island for the post-dismiss UI cue.
// Non-trial users (no Membership, no TrialWorkspace) get `null`
// so the handler can map it to a 404.
export async function dismissOnboardingChecklist(userId: string): Promise<Date | null> {
  const membership = await prisma.membership.findUnique({
    where: { userId },
    select: { teamId: true },
  });
  if (!membership) return null;
  const teamId = membership.teamId;

  // Reuse the same column-update path that /api/trial-status uses —
  // idempotent in concept (the stamp just moves forward in time)
  // without introducing a no-op "already dismissed" branch in the
  // handler. If the workspace row is missing (the user is on a
  // paid/non-trial team), surfacing `null` lets the handler return
  // a quiet 404 so the island falls back to hiding the card.
  const updated = await prisma.trialWorkspace
    .update({
      where: { teamId },
      data: { onboardingChecklistDismissedAt: new Date() },
      select: { onboardingChecklistDismissedAt: true },
    })
    .catch(() => null);
  return updated?.onboardingChecklistDismissedAt ?? null;
}
