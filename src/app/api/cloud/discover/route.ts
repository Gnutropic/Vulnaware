// @polsia:user-owned — POST /api/cloud/discover. Unified discover entry —
// accepts EITHER persisted `{provider, connectionId}` OR ephemeral
// `{provider, credentials}` and dispatches a queued run. Discriminator is
// the provider field; the body shape is decided by `CloudUnifiedDiscoverRequest`.
// Cron drains `*DiscoveryRun` rows after the post.

import 'server-only';
import { NextResponse } from 'next/server';
import { dispatchUnifiedDiscovery } from '@/lib/business/cloud/unified-dispatch';
import {
  CloudDiscoveryResponse,
  CloudUnifiedDiscoverRequest,
} from '@/lib/contracts/cloud-discover';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ errors: { _: 'Invalid JSON' } }, { status: 400 });
  }
  const parsed = CloudUnifiedDiscoverRequest.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return NextResponse.json({ errors: fieldErrors }, { status: 400 });
  }

  try {
    const dispatched = await dispatchUnifiedDiscovery({ userId: user.id, body: parsed.data });
    // Stamping lastTestedAt — convenient side effect for "this connection
    // was used recently" without forcing a run-id round-trip from the
    // caller. Setting lastTestedAt = now also acts as a release-date on
    // any future "stale connection" UI banner.
    try {
      await stampLastTested(dispatched.provider, dispatched.connectionId);
    } catch {
      // Swallow — the run is already queued; we don't want a stamp fail.
    }
    const body = CloudDiscoveryResponse.parse({
      id: dispatched.id,
      provider: dispatched.provider,
      status: 'queued',
      pollUrl: dispatched.pollUrl,
      connectionId: dispatched.connectionId,
    });
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 500 });
  }
}

async function stampLastTested(
  provider: 'aws' | 'azure' | 'gcp',
  connectionId: string,
): Promise<void> {
  const now = new Date();
  if (provider === 'aws') {
    await prisma.awsConnection.update({ where: { id: connectionId }, data: { lastTestedAt: now } });
  } else if (provider === 'azure') {
    await prisma.azureConnection.update({
      where: { id: connectionId },
      data: { lastTestedAt: now },
    });
  } else {
    await prisma.gcpConnection.update({ where: { id: connectionId }, data: { lastTestedAt: now } });
  }
}
