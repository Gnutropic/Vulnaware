// @polsia:user-owned — Per-alert cached AI-generated remediation advice.

import 'server-only';
import { NextResponse } from 'next/server';
import { AiConfigurationError, chat } from '@/lib/ai/client';
import {
  ALERT_REMEDIATION_PROMPT_VERSION,
  type AlertRemediationContext,
  buildAlertRemediationPrompt,
  missingAlertRemediationContext,
  normalizeAlertRemediationOutput,
} from '@/lib/business/alert-remediation-guidance';
import { requireAlertWorkspaceMember } from '@/lib/business/alert-workspace-access';
import {
  AlertCveFix,
  AlertCveFixInsufficientContext,
  AlertCveFixUnavailable,
} from '@/lib/contracts/alerts';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { setRequestAuth, withApiRequest } from '@/lib/logging/with-request';

export const dynamic = 'force-dynamic';

const MODEL_TAG = 'gpt-4o-mini';

function unavailable() {
  return AlertCveFixUnavailable.parse({ error: 'unavailable' });
}

function insufficientContext(missing: Array<'cve' | 'description'>) {
  return AlertCveFixInsufficientContext.parse({ error: 'insufficient_context', missing });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });
    const { id } = await params;

    try {
      const alert = await prisma.alert.findFirst({
        where: { id, teamId: ctx.workspaceId },
        select: { id: true },
      });
      if (!alert) return NextResponse.json({ error: 'not_found' }, { status: 404 });

      const row = await prisma.alertCveFix.findFirst({
        where: { alertId: id, teamId: ctx.workspaceId },
        select: { fixStepsJson: true, model: true, generatedAt: true, promptVersion: true },
      });
      if (!row || row.promptVersion !== ALERT_REMEDIATION_PROMPT_VERSION) {
        return NextResponse.json(unavailable());
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(row.fixStepsJson);
      } catch {
        return NextResponse.json(unavailable());
      }
      if (!Array.isArray(decoded)) return NextResponse.json(unavailable());
      const steps = decoded.filter(
        (step): step is { id: string; title: string; body: string } =>
          !!step &&
          typeof step === 'object' &&
          typeof (step as { id?: unknown }).id === 'string' &&
          typeof (step as { title?: unknown }).title === 'string' &&
          typeof (step as { body?: unknown }).body === 'string',
      );
      if (steps.length < 1) return NextResponse.json(unavailable());

      try {
        return NextResponse.json(
          AlertCveFix.parse({
            alertId: id,
            steps,
            generatedAt: row.generatedAt.toISOString(),
            model: row.model ?? null,
          }),
        );
      } catch {
        return NextResponse.json(unavailable());
      }
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiRequest(req, async () => {
    let ctx: Awaited<ReturnType<typeof requireAlertWorkspaceMember>>;
    try {
      ctx = await requireAlertWorkspaceMember(req);
    } catch (res) {
      return res as Response;
    }

    setRequestAuth({ userId: ctx.user.id, teamId: ctx.workspaceId });
    const { id } = await params;

    try {
      const alert = await prisma.alert.findFirst({
        where: { id, teamId: ctx.workspaceId },
        select: {
          id: true,
          severity: true,
          source: true,
          finding: {
            select: {
              cveId: true,
              asset: { select: { host: true, ip: true, port: true, protocol: true } },
            },
          },
        },
      });
      if (!alert) return NextResponse.json({ error: 'not_found' }, { status: 404 });

      const cveId = alert.finding?.cveId ?? '';
      const cveEntry = cveId
        ? await prisma.cveEntry.findUnique({
            where: { cveId },
            select: { cvssScore: true, description: true },
          })
        : null;
      const description = cveEntry?.description ?? '';
      const missing = missingAlertRemediationContext({ cveId, description });
      if (missing.length > 0) return NextResponse.json(insufficientContext(missing));

      if (!env.POLSIA_API_KEY && !env.POLSIA_API_TOKEN) {
        return NextResponse.json(unavailable(), { status: 503 });
      }

      const context: AlertRemediationContext = {
        cveId,
        description,
        cvssScore: cveEntry?.cvssScore ?? null,
        severity: alert.severity ?? null,
        source: alert.source,
        asset: {
          host: alert.finding?.asset?.host ?? '',
          ip: alert.finding?.asset?.ip ?? '',
          port: alert.finding?.asset?.port ?? 0,
          protocol: alert.finding?.asset?.protocol ?? '',
        },
      };
      const prompt = buildAlertRemediationPrompt(context);

      let raw: string;
      try {
        raw = await chat({
          task: 'cve-remediation-guidance',
          responseFormat: 'json_object',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        });
      } catch (error) {
        if (error instanceof AiConfigurationError) {
          return NextResponse.json(unavailable(), { status: 503 });
        }
        return NextResponse.json(unavailable(), { status: 503 });
      }

      const steps = normalizeAlertRemediationOutput(raw);
      if (!steps) return NextResponse.json(unavailable(), { status: 503 });

      const generatedAt = new Date();
      await prisma.alertCveFix.upsert({
        where: { alertId: id },
        create: {
          alertId: id,
          teamId: ctx.workspaceId,
          fixStepsJson: JSON.stringify(steps),
          model: MODEL_TAG,
          promptVersion: ALERT_REMEDIATION_PROMPT_VERSION,
          generatedAt,
        },
        update: {
          teamId: ctx.workspaceId,
          fixStepsJson: JSON.stringify(steps),
          model: MODEL_TAG,
          promptVersion: ALERT_REMEDIATION_PROMPT_VERSION,
          generatedAt,
        },
      });

      return NextResponse.json(
        AlertCveFix.parse({
          alertId: id,
          steps,
          generatedAt: generatedAt.toISOString(),
          model: MODEL_TAG,
        }),
      );
    } catch {
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  });
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
