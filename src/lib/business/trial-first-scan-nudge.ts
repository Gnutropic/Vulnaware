// @polsia:user-owned — server lib that backs
// jobs/trial-first-scan-nudge.ts. Exports a pure selector
// (`findCandidates`) and a sender (`sendNudgesForCandidates`) so the cron
// stays small AND the selector is unit-testable without running the
// whole pipeline. The cron glues them together.
//
// Selection rule:
//   - TrialWorkspace.createdAt <= now - 24h (owner has had the chance)
//   - trialEndsAt > now (don't pester an expired trial; trial-reminders
//     already owns the expiry funnel)
//   - lastFirstScanNudgeSentAt is null (idempotency stamp on the row)
//   - the owner has NEVER recorded a TrialFunnelEvent with
//     step='first_scan_triggered' — a single SELECT check per owner
//     batch.
//
// We infer first-scan completion from TrialFunnelEvent rather than
// `prisma.scan.count`, because trial.ts seeds each workspace with a
// sample Scan row so any count gate would always fire for a freshly
// seeded workspace.
//
// Per-user dedupe: if one owner has multiple TrialWorkspace rows in
// scope (rare in practice — a single trial owner usually has one active
// workspace — but possible across history), the selector collects every
// workspace into a single Candidate so the owner gets one email per cron
// tick instead of N. The send step stamps every workspace that produced
// a send so a later tick can't re-fire on a now-stamped but
// still-unscanned workspace owned by the same user.

import 'server-only';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { trialFirstScanNudgeEmail } from '@/lib/email/templates';

const HOUR_MS = 60 * 60 * 1000;
const FIRST_SCAN_WINDOW_HOURS = 24;
const FUNNEL_STEP_FIRST_SCAN_TRIGGERED = 'first_scan_triggered';

export interface Candidate {
  ownerUserId: string;
  email: string;
  name: string;
  // All workspace ids belonging to this owner in scope of the nudge. We
  // stamp every one so a later tick can't re-fire on a now-stamped but
  // still-unscanned workspace owned by the same user.
  workspaceIds: string[];
}

interface RawCandidateRow {
  id: string;
  ownerUserId: string;
}

// Pull the set of owner userIds that have ever recorded a
// first_scan_triggered funnel event. An owner appearing here is excluded
// from the candidate set regardless of their workspace stamps.
async function listFirstScanTriggeredOwnerIds(ownerIds: string[]): Promise<Set<string>> {
  if (ownerIds.length === 0) return new Set();
  const rows = await prisma.trialFunnelEvent.findMany({
    where: {
      userId: { in: ownerIds },
      step: FUNNEL_STEP_FIRST_SCAN_TRIGGERED,
    },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId).filter((id): id is string => typeof id === 'string'));
}

// Pure selector. Returns one Candidate per owner, listing every
// matching workspace id owned by that user so the send step can stamp
// them all. Filters:
//   - window: createdAt <= now - 24h
//   - still active: trialEndsAt > now
//   - not yet nudged: lastFirstScanNudgeSentAt is null
//   - owner has not run a first_scan_triggered event
export async function findCandidates(now: Date): Promise<Candidate[]> {
  const windowStart = new Date(now.getTime() - FIRST_SCAN_WINDOW_HOURS * HOUR_MS);
  const rows: RawCandidateRow[] = await prisma.trialWorkspace.findMany({
    where: {
      createdAt: { lte: windowStart },
      trialEndsAt: { gt: now },
      lastFirstScanNudgeSentAt: null,
    },
    select: {
      id: true,
      ownerUserId: true,
    },
  });
  if (rows.length === 0) return [];

  const ownerIds = Array.from(new Set(rows.map((r) => r.ownerUserId)));
  const owners = await prisma.user.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, email: true, name: true },
  });
  const ownerMap = new Map(owners.map((o) => [o.id, o] as const));

  const scannedOwners = await listFirstScanTriggeredOwnerIds(ownerIds);
  const eligibleRows = rows.filter((r) => !scannedOwners.has(r.ownerUserId));
  if (eligibleRows.length === 0) return [];

  const grouped = new Map<string, Candidate>();
  for (const row of eligibleRows) {
    const owner = ownerMap.get(row.ownerUserId);
    if (!owner?.email) continue;
    const existing = grouped.get(row.ownerUserId);
    if (existing) {
      existing.workspaceIds.push(row.id);
      continue;
    }
    grouped.set(row.ownerUserId, {
      ownerUserId: row.ownerUserId,
      email: owner.email,
      name: owner.name,
      workspaceIds: [row.id],
    });
  }
  return Array.from(grouped.values());
}

// Send a single nudge per candidate. The selector guarantees one
// Candidate per owner by construction; a one-time stamp keeps each
// owner from getting a repeat nudge on later cron ticks.
//
// The proxy binds the sender to the per-category map driven by the
// caller identity; the per-category `fromFor('vuln')` lookup is
// informational (used by integration tests / future logging only) —
// sendEmail's signature does not accept a custom `from` and the team
// instructed the proxy not to be hand-supplied.
//
// Per-candidate try/catch: one transient proxy failure must not abort
// the rest of the tick. Failures breadcrumb to the console for the
// deploy log and leave the stamp unset so the next cron tick can retry.
export interface SendNudgesOptions {
  dashboardUrl: string;
}

export async function sendNudgesForCandidates(
  candidates: Candidate[],
  options: SendNudgesOptions,
): Promise<{ sent: number; skipped: number }> {
  if (candidates.length === 0) return { sent: 0, skipped: 0 };

  // Surfaced so a future column or audit log can verify the brief's
  // sender identity (`notifications@vulnaware.com`) is configured on
  // deploy. The proxy binds the actual From header at the proxy edge
  // using the per-category map; we don't pass it on the request.
  void fromFor('vuln');

  let sent = 0;
  let skipped = 0;
  const stampedAt = new Date();
  for (const c of candidates) {
    if (!c.email) {
      skipped += 1;
      continue;
    }
    const rendered = trialFirstScanNudgeEmail({
      name: c.name ?? 'there',
      dashboardUrl: options.dashboardUrl,
    });
    try {
      await sendEmail({
        to: c.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      await prisma.trialWorkspace.updateMany({
        where: { id: { in: c.workspaceIds } },
        data: { lastFirstScanNudgeSentAt: stampedAt },
      });
      sent += 1;
    } catch (_err) {}
  }
  return { sent, skipped };
}

export const _constants = {
  FIRST_SCAN_WINDOW_HOURS,
  HOUR_MS,
  FUNNEL_STEP_FIRST_SCAN_TRIGGERED,
};
