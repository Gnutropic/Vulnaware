// @polsia:user-owned — public GET /api/changelog.
// Source: const seed in @/lib/content/changelog; authored order is preserved
// and validated through the shared zod contract before it leaves the server.
// No Prisma, no session seam — the page is a public marketing artifact.

import 'server-only';
import { NextResponse } from 'next/server';
import { CHANGELOG_ENTRIES } from '@/lib/content/changelog';
import { ChangelogList } from '@/lib/contracts/changelog';

// The const seed never changes between requests; force-static lets the build
// emit one response and skip per-request work. (No Prisma reads → no ISR
// invalidation concern; a const seed change ships on the next deploy.)
export const dynamic = 'force-static';

export async function GET() {
  const payload = ChangelogList.parse({ entries: CHANGELOG_ENTRIES });
  return NextResponse.json(payload, { status: 200 });
}
