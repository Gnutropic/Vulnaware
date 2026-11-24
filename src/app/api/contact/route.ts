// @polsia:user-owned
//
// POST /api/contact — public contact-form submission endpoint.
// Lives under /api, so proxy.ts's matcher excludes it (no CSP/nonce, not proxied).
// Anonymous by design: visitor submits the public /contact form with no session.
//
// Pipeline:
//   1. JSON parse → 400 envelope on parse failure.
//   2. zod validate (shared @/lib/contact/schema contract) → 400 flat-map on fail.
//   3. Honeypot: if `website` is non-empty, return 200 immediately and DO NOT
//      send mail. Silent 200 is the trap — bots can't tell we know.
//   4. Resolve recipient = POLSIA_COMPANY_EMAIL ?? brand.contactEmail.
//   5. sendEmail() through the installed email proxy.
//   6. Return 200 { ok: true, sentAt } on success; 502 { error: 'send_failed' }
//      on proxy failure (no proxy detail leaked in body).

import 'server-only';
import { NextResponse } from 'next/server';
import { brand } from '@/lib/brand';
import { contactResponseSchema, contactSchema } from '@/lib/contact/schema';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email/send';
import { contactSubmissionEmail } from '@/lib/email/templates';
import { emitErrorLogEvent } from '@/lib/logging/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ErrorBody {
  errors?: Record<string, string>;
  error?: string;
}

function badRequest(errors: Record<string, string>) {
  return NextResponse.json<ErrorBody>({ errors }, { status: 400 });
}

export async function POST(req: Request) {
  // Body parse — 400 with a generic envelope (the form island maps
  // `message` field errors back to the textarea).
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest({ message: 'Invalid request body.' });
  }
  if (!raw || typeof raw !== 'object') {
    return badRequest({ message: 'Invalid request body.' });
  }
  const body = raw as Record<string, unknown>;

  const parsed = contactSchema.safeParse({
    name: body.name,
    email: body.email,
    company: body.company,
    message: body.message,
    website: body.website,
    teamSize: body.teamSize,
  });

  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    // trim undefineds — applyServerErrors applies a `string` message per field,
    // so we only forward fields that actually have a message.
    const errors: Record<string, string> = {};
    if (flat.name?.[0]) errors.name = flat.name[0];
    if (flat.email?.[0]) errors.email = flat.email[0];
    if (flat.company?.[0]) errors.company = flat.company[0];
    if (flat.message?.[0]) errors.message = flat.message[0];
    return badRequest(errors);
  }

  // Honeypot trap: a real visitor never fills `website`; a bot does.
  // Return the success envelope with no side effects so the bot can't tell
  // we caught it.
  if (parsed.data.website && parsed.data.website.length > 0) {
    return NextResponse.json(
      contactResponseSchema.parse({ ok: true, sentAt: new Date().toISOString() }),
    );
  }

  // Recipient resolution — deploy-injected env wins; brand id is the
  // snapshot fallback so a fresh clone without env still routes to the
  // company's vulnaware@polsia.app inbox.
  const to = (process.env.POLSIA_COMPANY_EMAIL ?? brand.contactEmail ?? '').trim();
  if (!to) {
    return NextResponse.json<ErrorBody>({ error: 'recipient_unconfigured' }, { status: 503 });
  }

  const submittedAt = new Date().toISOString();
  const sentAt = submittedAt;
  const userAgent = req.headers.get('user-agent') ?? 'unknown';
  const teamSize = parsed.data.teamSize;
  // Persisted `message` is the canonical inquiry body — fold team size and
  // company context into a single self-contained string so the row round-
  // trips into the submissions table without a schema change. Email uses
  // the same text.
  const persistedMessage = teamSize
    ? `[Team size] ${teamSize}\n\n${parsed.data.message}\n\n— Company: ${parsed.data.company ?? '—'}`
    : `${parsed.data.message}\n\n— Company: ${parsed.data.company ?? '—'}`;

  try {
    await sendEmail({
      to,
      ...contactSubmissionEmail({
        name: parsed.data.name,
        email: parsed.data.email,
        company: parsed.data.company,
        message: persistedMessage,
        submittedAt,
        userAgent,
        teamSize,
      }),
    });
  } catch (err) {
    // Surface a stable shape to the client — never leak the proxy's
    // internal text verbatim. The full error stays in the structured log.
    emitErrorLogEvent({
      ts: new Date().toISOString(),
      msg: 'api.contact.send_failed',
      to,
      err:
        err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) },
    });
    return NextResponse.json<ErrorBody>({ error: 'send_failed' }, { status: 502 });
  }

  // Persist a queryable audit row. Best-effort — the email has already gone
  // out, so a DB write hiccup is logged but does not fail the user's POST.
  try {
    await prisma.contactMessage.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        message: persistedMessage,
      },
    });
  } catch (err) {
    emitErrorLogEvent({
      ts: new Date().toISOString(),
      msg: 'api.contact.persist_failed',
      err:
        err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) },
    });
  }

  return NextResponse.json(contactResponseSchema.parse({ ok: true, sentAt }));
}
