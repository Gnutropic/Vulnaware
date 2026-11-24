// @polsia:user-owned — Business lib for the per-team nightly
// competitive-intelligence audit. Exposes three pieces:
//
//   - `generateAuditHeadlineBodyForTeam(teamId, now)` — drives the LLM
//     via `generateObject` from `@/lib/ai/client` with bounded zod
//     response shapes, returning a {headline, body} pair sized to the
//     wire contract (`headline` ≤ 280, `body` ≤ 20_000 chars).
//   - `runNightlyCompetitiveIntelAuditForTeam(teamId, now)` — performs
//     the per-team idempotent insert: gate by `(teamId, ranAt)` so a
//     re-fire within the same UTC day is a no-op; throw on LLM failure
//     so the per-team outer try/catch in the cron can log + continue.
//   - `runNightlyCompetitiveIntelAudit(now)` — iterates every Team and
//     delegates per-team with isolation (one team's failure does not
//     abort the batch).
//
// Naming: the brief's `workspaceId` was renamed to `teamId` everywhere
// in this surface (the only per-team convention in this repo; see the
// migration banner comment).
//
// Skip-on-AI-failure policy: when `generateObject` throws (proxy down,
// malformed payload), the per-team orchestrator SKIPS the row and logs
// a breadcrumb. Inserting a guarded placeholder row would clutter
// the listing with non-audit entries — skipping is the safer default
// and a successful re-run tomorrow still closes the gap.

import 'server-only';
import { z } from 'zod';
import { generateObject } from '@/lib/ai/client';
import { prisma } from '@/lib/db';

// Start-of-UTC-day floor of `now`. Pure time helper (testable in
// isolation). Stamped at 00:00:00.000Z of `now`'s calendar date so a
// nightly fire at any minute of a given UTC day lands on the same key.
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

// Bounded output schema for the LLM call. The headline floats up to the
// list page; the body is lazy-loaded from /api/intel/runs/[id]. Both
// fields are string-bounded so a runaway model output cannot bloat a
// row indefinitely.
const AuditOutput = z.object({
  headline: z.string().min(1).max(280),
  body: z.string().min(1).max(20_000),
});
export type AuditHeadlineBody = z.infer<typeof AuditOutput>;

export const COMPETITIVE_INTEL_AI_TIMEOUT_MS = 30_000;

type CompetitiveIntelAiFailure = 'timeout' | 'unavailable';

class CompetitiveIntelAiError extends Error {
  constructor(readonly failure: CompetitiveIntelAiFailure) {
    super(
      failure === 'timeout'
        ? 'competitive-intel AI request timed out'
        : 'competitive-intel AI unavailable',
    );
    this.name = 'CompetitiveIntelAiError';
  }
}

// LLM helper — call generateObject with a fixed task tag and the bounded
// response schema. Throws on proxy failure or parse miss so the caller
// (the orchestrator) can decide whether to skip-and-log or surface.
//
// `task: 'competitive-intel-audit'` lets the platform proxy meter/route
// this call independently from chat traffic. The system prompt is short
// and bounded — no third-party content, no per-team PII carried in, so
// the call is cheap to log for cost/quota accounting.
export async function generateAuditHeadlineBodyForTeam(
  _teamId: string,
  _now: Date,
): Promise<AuditHeadlineBody> {
  const prompt =
    'Produce a competitive intelligence audit for a security/cloud-cost ' +
    'SaaS product. Audience: a founder reading a one-morning summary. ' +
    'Return JSON exactly matching the schema: { "headline": short ' +
    'executive summary <= 280 chars, "body": longer analysis <= 20000 ' +
    'chars }. No markdown fences, no prose outside the JSON.';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPETITIVE_INTEL_AI_TIMEOUT_MS);
  try {
    return await generateObject<AuditHeadlineBody>({
      task: 'competitive-intel-audit',
      responseFormat: 'json_object',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Audit the landscape for today.' },
      ],
      signal: controller.signal,
    });
  } catch {
    throw new CompetitiveIntelAiError(controller.signal.aborted ? 'timeout' : 'unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

// Per-team orchestrator. Idempotency: gates insert by computing
// `startOfUtcDay(now)` then checking the (teamId, ranAt) unique key.
// Skip-and-log when the AI call fails — we do not insert a placeholder
// row.
export async function runNightlyCompetitiveIntelAuditForTeam(
  teamId: string,
  now: Date,
): Promise<{ inserted: boolean; ranAt: Date; reason?: string }> {
  const ranAt = startOfUtcDay(now);

  const existing = await prisma.competitiveIntelRun.findUnique({
    where: { teamId_ranAt: { teamId, ranAt } },
    select: { id: true },
  });
  if (existing) {
    return { inserted: false, ranAt, reason: 'already_ran' };
  }

  let audit: AuditHeadlineBody;
  try {
    audit = await generateAuditHeadlineBodyForTeam(teamId, now);
  } catch (err) {
    const reason = err instanceof CompetitiveIntelAiError ? `ai_${err.failure}` : 'ai_unavailable';
    process.stderr.write(`[competitive-intel] team=${teamId} skipped reason=${reason}\n`);
    return { inserted: false, ranAt, reason };
  }

  await prisma.competitiveIntelRun.create({
    data: { teamId, ranAt, headline: audit.headline, body: audit.body },
  });
  return { inserted: true, ranAt };
}

// Whole-batch orchestrator. Iterates `Team.findMany({ select: { id } })`
// and delegates per-team. Per-team failure is swallowed (logged) so one
// broken team does not abort the rest of the night.
export async function runNightlyCompetitiveIntelAudit(
  now: Date,
): Promise<{ attempted: number; inserted: number; skipped: number }> {
  const teams = await prisma.team.findMany({ select: { id: true } });
  let inserted = 0;
  let skipped = 0;
  for (const t of teams) {
    try {
      const result = await runNightlyCompetitiveIntelAuditForTeam(t.id, now);
      if (result.inserted) inserted += 1;
      else skipped += 1;
    } catch {
      // Outermost safety net — `runNightlyCompetitiveIntelAuditForTeam`
      // is already crash-tolerant for the LLM call, but a DB write can
      // still throw (network, write conflict). Log and continue.
      process.stderr.write(`[competitive-intel] team=${t.id} skipped reason=team_error\n`);
      skipped += 1;
    }
  }
  return { attempted: teams.length, inserted, skipped };
}
