// @polsia:user-owned — server lib that backs jobs/alert-dispatch.ts.
// Exports a pure selector (`findDispatchableAlerts`) and a sender
// (`sendDispatchQueue`) so the cron stays small AND the selector is
// unit-testable without running the whole pipeline.
//
// Selection rule:
//   - Alert.dispatchedAt IS NULL          (idempotency stamp: a row
//                                           already emailed to its team
//                                           admins is never picked up
//                                           again)
//   - Alert.createdAt <= now - 60s        (give the writer at least a
//                                           minute to commit before we
//                                           announce it to admins)
//
// Recipient resolution:
//   - For each candidate row, gather distinct teamIds, then batch a
//     single `prisma.membership.findMany` over `role='admin'` rows for
//     those teams so we don't round-trip per row.
//   - Batch a single `prisma.user.findMany` over the resolved admin
//     userIds to lift emails in one shot.
//
// Stamp semantics (intentional compromise — see rationale below):
//   - The row is stamped (`dispatchedAt = now`) ONLY when every
//     recipient currently in scope for that alert sends successfully.
//   - One recipient failure leaves the row unstamped so the next tick
//     retries; that next tick re-evaluates membership from
//     findDispatchableAlerts so a recently-removed admin won't get a
//     retry. The compromise: an admin added AFTER the stamp won't
//     retroactively receive that alert — accepted because the natural
//     unit of idempotency is the alert row (one stamp column, no
//     per-envelope audit log) and the brief scopes delivery to "the
//     team's admin(s) at dispatch time".
//
// fromFor('alerts'):
//   - Looked up once and discarded as informational. The proxy binds
//     the actual `From` header at the edge using the per-category map.
//     sendEmail() does not accept a custom `from` and the email proxy
//     intentionally rejects attachments, cc/bcc, and custom From.
//     Same pattern as src/lib/business/trial-first-scan-nudge.ts.

import 'server-only';
import { prisma } from '@/lib/db';
import { fromFor } from '@/lib/email/from';
import { sendEmail } from '@/lib/email/send';
import { alertEmail } from '@/lib/email/templates';

const SIXTY_SECONDS_MS = 60 * 1000;
const ADMIN_ROLE = 'admin';

export interface DispatchableAlert {
  alertId: string;
  teamId: string;
  severity: string;
  findingTitle: string;
  recipients: { email: string }[];
}

interface RawAlertRow {
  id: string;
  teamId: string;
  findingId: string;
  severity: string | null;
  source: string;
  createdAt: Date;
}

// Pure selector. Returns one DispatchableAlert per matching Alert row,
// each with its current team-admin recipients (User.email) materialized.
// Filters:
//   - idempotency: dispatchedAt IS NULL
//   - 60s grace period: createdAt <= now - 60s
export async function findDispatchableAlerts(now: Date): Promise<DispatchableAlert[]> {
  const windowStart = new Date(now.getTime() - SIXTY_SECONDS_MS);
  const rows: RawAlertRow[] = await prisma.alert.findMany({
    where: {
      dispatchedAt: null,
      createdAt: { lte: windowStart },
    },
    select: {
      id: true,
      teamId: true,
      findingId: true,
      severity: true,
      source: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) return [];

  const findingIds = Array.from(new Set(rows.map((r) => r.findingId)));
  const findings = await prisma.vulnerabilityFinding.findMany({
    where: { id: { in: findingIds } },
    select: { id: true, cveId: true },
  });
  const titleByFindingId = new Map<string, string>(findings.map((f) => [f.id, f.cveId] as const));

  const teamIds = Array.from(new Set(rows.map((r) => r.teamId)));
  const memberships = await prisma.membership.findMany({
    where: {
      teamId: { in: teamIds },
      role: ADMIN_ROLE,
    },
    select: { userId: true, teamId: true },
  });

  const adminUserIds = Array.from(new Set(memberships.map((m) => m.userId)));
  const admins = await prisma.user.findMany({
    where: { id: { in: adminUserIds } },
    select: { id: true, email: true },
  });
  const emailByUserId = new Map(
    admins
      .filter((a): a is { id: string; email: string } => Boolean(a.email))
      .map((a) => [a.id, a.email] as const),
  );

  const recipientsByTeam = new Map<string, { email: string }[]>();
  for (const m of memberships) {
    const email = emailByUserId.get(m.userId);
    if (!email) continue;
    const list = recipientsByTeam.get(m.teamId) ?? [];
    list.push({ email });
    recipientsByTeam.set(m.teamId, list);
  }

  return rows.map((r) => ({
    alertId: r.id,
    teamId: r.teamId,
    severity: r.severity ?? 'unknown',
    findingTitle: titleByFindingId.get(r.findingId) ?? '(unknown finding)',
    recipients: recipientsByTeam.get(r.teamId) ?? [],
  }));
}

export interface SendDispatchQueueOptions {
  appBaseUrl: string;
}

export interface SendDispatchQueueResult {
  sent: number;
  failed: number;
  skipped: number;
}

// Send the dispatch queue. Per-recipient try/catch wraps every
// sendEmail call so one bad admin does not abort the rest of the
// batch. The row is stamped only when every recipient currently in
// scope sent successfully; partial failures leave the row unstamped so
// the next cron retry can re-evaluate membership and re-send.
//
// Returns `sent` (envelopes delivered), `failed` (envelopes that
// threw), and `skipped` (alerts with no current admin recipients —
// those stay unstamped so a future admin promotion triggers a send).
export async function sendDispatchQueue(
  dispatchable: DispatchableAlert[],
  now: Date,
  options: SendDispatchQueueOptions,
): Promise<SendDispatchQueueResult> {
  if (dispatchable.length === 0) {
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Informational only — see the file header.
  void fromFor('alerts');

  const base = options.appBaseUrl.replace(/\/+$/, '');
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const alert of dispatchable) {
    if (alert.recipients.length === 0) {
      skipped += 1;
      continue;
    }
    const ctaUrl = `${base}/alerts/${alert.alertId}`;
    const rendered = alertEmail({
      severity: alert.severity,
      findingTitle: alert.findingTitle,
      ctaUrl,
    });

    let successfulEnvelopeCount = 0;
    for (const recipient of alert.recipients) {
      try {
        await sendEmail({
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        successfulEnvelopeCount += 1;
        sent += 1;
      } catch (_err) {
        failed += 1;
      }
    }

    if (successfulEnvelopeCount === alert.recipients.length) {
      await prisma.alert.update({
        where: { id: alert.alertId },
        data: { dispatchedAt: now },
      });
    }
  }
  return { sent, failed, skipped };
}

export const _constants = {
  SIXTY_SECONDS_MS,
  ADMIN_ROLE,
};
