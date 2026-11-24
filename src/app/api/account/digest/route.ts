// @polsia:user-owned — Per-user "Receive daily digest" preferences
// handler.
//
// GET  /api/account/digest — return the caller's prefs row
//        (`{ digestEnabled, severityThreshold, assetScope, lastSentAt,
//        updatedAt }`), upserting defaults on first read so a brand-
//        new user sees `digestEnabled: true` immediately (mirrors how
//        `getUserWebhookConfig` reads + lazily proceeds).
//
// PUT  /api/account/digest — upsert one-or-more of the prefs knobs
//        (`digestEnabled`, `severityThreshold`, `assetScope`). Body
//        shape is `DigestPrefsSetBody` (zod): all three keys are
//        optional so the UI can save a partial change; an empty body
//        (no keys present) is rejected with 400 so a no-op PUT does
//        not silently round-trip. Writes an audit row stamped with
//        the caller's Membership team — the audit metadata carries
//        only the keys that were present AND whose values actually
//        changed so a redundant save is audit-quiet.
//
// Access-control posture:
//   - Per-user: `requireAuth(req)` (anon → 401). No admin role needed
//     — every authed user toggles their OWN row.
//   - `setRequestAuth({ userId })` without `teamId`: this is per-user.
//     `audit()` expects a non-null `actorTeamId` so the audit callsite
//     resolves the caller's Membership.teamId first and falls back to
//     'unattributed' for an authed user with no team.
//   - lastSentAt is server-controlled — never accepted from the body
//     even if a future zod widening inadvertently allows it through.

import 'server-only';
import { NextResponse } from 'next/server';
import { AssetFilterError, parseAssetName } from '@/lib/business/alerts-asset';
import { audit, extractIp } from '@/lib/business/audit';
import {
  DigestPrefsGetResponse,
  type DigestPrefsItem,
  DigestPrefsSetBody,
} from '@/lib/contracts/digest-prefs';
import { prisma } from '@/lib/db';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, PUT, POST' } },
  );
}

// Cope the persisted Prisma row into the wire int — typed helper so
// GET + PUT share one source of truth (same shape the contract
// validates on the client). `updatedAt` is the DB row's last-write
// timestamp; `lastSentAt` may be null until the cron runs.
function rowToWire(row: {
  digestEnabled: boolean;
  severityThreshold: string | null;
  assetScope: unknown;
  lastSentAt: Date | null;
  updatedAt: Date;
}): DigestPrefsItem {
  return DigestPrefsGetResponse.parse({
    digestEnabled: row.digestEnabled,
    severityThreshold: row.severityThreshold,
    assetScope: Array.isArray(row.assetScope) ? row.assetScope : [],
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

// First-read upsert helper. Mirrors `getUserWebhookConfig` — a user
// with no row yet sees the column defaults (`digestEnabled: true`,
// `severityThreshold: null`, `assetScope: null`, `updatedAt = now`)
// and the same row is returned on subsequent reads.
async function upsertDigestPrefs(userId: string) {
  return prisma.dailyDigestPrefs.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function GET(req: Request) {
  return withApiRequest(req, async () => {
    let user: SessionUser;
    try {
      user = await requireAuth(req);
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: user.id });

    try {
      const row = await upsertDigestPrefs(user.id);
      return NextResponse.json(rowToWire(row));
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export async function PUT(req: Request) {
  return withApiRequest(req, async () => {
    let user: SessionUser;
    try {
      user = await requireAuth(req);
    } catch (res) {
      return res as Response;
    }
    setRequestAuth({ userId: user.id });

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return NextResponse.json({ code: 'bad_request', message: 'invalid JSON' }, { status: 400 });
    }
    const parsed = DigestPrefsSetBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const body = parsed.data;

    // A no-op PUT — none of the optional keys were present — is a
    // client bug; reject with 400 so the UI can't re-render a silent
    // "no change" toast.
    if (
      body.digestEnabled === undefined &&
      body.severityThreshold === undefined &&
      body.assetScope === undefined
    ) {
      return NextResponse.json(
        {
          error: 'bad_request',
          message:
            'At least one preference key (digestEnabled, severityThreshold, assetScope) is required.',
        },
        { status: 400 },
      );
    }

    // Validate each assetScope entry through the same parser the
    // /alerts asset filter uses. Even though the request lands as an
    // array (not a CSV), we still want to surface a 400 — not a 500 —
    // when a tampered client posts a malformed name. Sort + dedupe in
    // place so the persisted set matches what `parseAssetFilter` would
    // canonicalize (alphabetical, deduped) and the GET round-trips
    // byte-for-byte.
    let normalisedAssetScope: string[] | undefined;
    if (body.assetScope !== undefined) {
      const seen = new Set<string>();
      const canonical: string[] = [];
      for (const name of body.assetScope) {
        if (typeof name !== 'string' || name.length === 0) continue;
        const parsed = parseAssetName(name);
        if (parsed == null) {
          throw new AssetFilterError(
            'malformed_name',
            `assetScope entry "${name}" is not in host:port/protocol shape.`,
          );
        }
        if (!seen.has(name)) {
          seen.add(name);
          canonical.push(name);
        }
      }
      canonical.sort((a, b) => a.localeCompare(b));
      normalisedAssetScope = canonical;
    }

    try {
      // Build a sparse create/update payload from the keys actually
      // present in the body. Existing rows keep their untouched columns
      // verbatim — `create` only stamps the literal defaults for a
      // brand-new user (whose values are exactly the column defaults
      // anyhow).
      const createData = {
        userId: user.id,
        ...(body.digestEnabled !== undefined ? { digestEnabled: body.digestEnabled } : {}),
        ...(body.severityThreshold !== undefined
          ? { severityThreshold: body.severityThreshold }
          : {}),
        ...(normalisedAssetScope !== undefined ? { assetScope: normalisedAssetScope } : {}),
      };
      const updateData = {
        ...(body.digestEnabled !== undefined ? { digestEnabled: body.digestEnabled } : {}),
        ...(body.severityThreshold !== undefined
          ? { severityThreshold: body.severityThreshold }
          : {}),
        ...(normalisedAssetScope !== undefined ? { assetScope: normalisedAssetScope } : {}),
      };

      const previous = await prisma.dailyDigestPrefs.findUnique({
        where: { userId: user.id },
        select: {
          id: true,
          digestEnabled: true,
          severityThreshold: true,
          assetScope: true,
        },
      });

      const row = await prisma.dailyDigestPrefs.upsert({
        where: { userId: user.id },
        create: createData,
        update: updateData,
      });

      // Diff the OLD row from the NEW row so audit metadata only
      // carries the keys that actually changed. If nothing changed
      // (e.g. a redundant duplicate save) we still log the request
      // with `unchanged: true` so the operator's audit trail carries
      // a stamp, but the field carry is otherwise empty.
      const previousAssetScope: string[] = Array.isArray(previous?.assetScope)
        ? (previous?.assetScope as string[])
        : [];
      const metadata: Record<string, string | number | boolean | string[] | null> = {};
      if (
        body.digestEnabled !== undefined &&
        (previous?.digestEnabled ?? null) !== row.digestEnabled
      ) {
        metadata.digestEnabled = row.digestEnabled;
      }
      if (
        body.severityThreshold !== undefined &&
        (previous?.severityThreshold ?? null) !== row.severityThreshold
      ) {
        metadata.severityThreshold = row.severityThreshold;
      }
      if (
        normalisedAssetScope !== undefined &&
        !arraysEqual(previousAssetScope, normalisedAssetScope)
      ) {
        metadata.assetScope = normalisedAssetScope;
      }
      if (Object.keys(metadata).length === 0) {
        metadata.unchanged = true;
      }

      // Audit() requires a non-null actorTeamId; resolve it to the
      // user's single Membership so the operator's audit trail matches
      // the team-scoped listing on /admin/audit. Falls back to the
      // placeholder team for an authed user with no team.
      const membership = await prisma.membership.findUnique({
        where: { userId: user.id },
        select: { teamId: true },
      });
      void audit({
        actorUserId: user.id,
        actorTeamId: membership?.teamId ?? 'unattributed',
        action: 'daily_digest.set',
        resourceType: 'daily_digest',
        resourceId: row.id,
        metadata,
        ipAddress: extractIp(req),
      });
      return NextResponse.json(rowToWire(row));
    } catch (err) {
      if (err instanceof AssetFilterError) {
        return NextResponse.json(
          { error: 'bad_request', message: err.message, code: err.code },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function arraysEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const POST = PUT;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
