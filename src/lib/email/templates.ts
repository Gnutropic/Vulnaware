// @polsia:user-owned — your email templates. Edit, add, or delete freely.
// Each template returns { subject, html, text }; send it via the framework transport:
//   import { sendEmail } from '@/lib/email/send';
//   import { welcomeEmail } from '@/lib/email/templates';
//   await sendEmail({ to: user.email, ...welcomeEmail({ name: user.name }) });
// renderEmail() is a plain inline-styled shell — email clients drop <style>/<link>, so style inline.
// renderEmail() auto-escapes its heading/body/cta/footer, so pass RAW values (don't escapeHtml() them
// first — that double-escapes). escapeHtml() is only for when you hand-build an html string yourself.

import { brand } from '@/lib/brand';

/** Subject + rendered bodies — spread into sendEmail({ to, ... }). */
export interface EmailContent {
  subject: string;
  html: string;
  text?: string;
}

export interface EmailLink {
  /** Discriminator so string-only callers stay call-site compatible. */
  kind: 'link';
  /** Visible text of the link. */
  text: string;
  /** Target URL — escaped for you. */
  href: string;
}

/**
 * Inline-styled severity chip — emitted BEFORE the deep-link row so a
 * reader's eye lands on the color first then the link. The chip is a
 * `<span>` (not a `<div>`) because mail clients drop block-level styling
 * inside table cells. Color map mirrors the on-page shadcn `badge`
 * variant mapping the alert-row chip uses:
 *   - critical/high → `#b91c1c` (red-700)
 *   - medium        → `#92400e` (amber-800)
 *   - other         → `#374151` (slate-700)
 * Used by `snoozeDigestEmail`'s per-row rendering only; the dailyUser,
 * dailyAlert, and weeklyRisk digests render their rows as plain
 * `{kind:'link'}` entries and continue to bypass the chip entry.
 */
export interface EmailChip {
  kind: 'chip';
  /** Short tag text — left side of the color chip. Lower-cased. */
  text: string;
  /** Hex color for the chip background. */
  bg: string;
  /** Hex color for the chip foreground — picked to keep contrast ≥ 4.5:1
   *  against `bg`. We pick '#ffffff' for the red + slate chips and
   *  '#ffffff' for amber so the rendering is consistent across clients. */
  fg: string;
}

/**
 * Day-bucket heading — emitted BEFORE a per-day block of `{kind:'chip'}`
 * rows. Renders as a heading-style paragraph with extra top-margin to
 * separate from the prior block. Used by `snoozeDigestEmail` to group
 * rows by the UTC calendar day of `snoozedUntil`; today → "Today (N)",
 * yesterday → "Yesterday (N)", earlier → "YYYY-MM-DD (N)".
 */
export interface EmailDay {
  kind: 'day';
  label: string;
}

export interface RenderEmailOptions {
  heading: string;
  /**
   * Body content: each entry is either a plain paragraph (escaped for you),
   * a `{ kind: 'link' }` paragraph that renders an `<a href="…">text</a>`
   * so per-alert rows in the digest template can link back to /alerts/[id],
   * a `{ kind: 'chip' }` row that emits an inline-styled severity chip
   * (used by the snooze digest for per-row severity), or a
   * `{ kind: 'day' }` heading that separates a per-day bucket from the
   * previous one (used by the snooze digest for grouping rows by
   * `snoozedUntil`'s UTC calendar day).
   */
  body: (string | EmailLink | EmailChip | EmailDay)[];
  /** Optional call-to-action button. */
  cta?: { label: string; url: string };
  /** Optional footer line under the divider. */
  footer?: string;
}

/** Escape a value for safe interpolation into an HTML attribute or text node. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap content in a minimal, inline-styled email shell. Restyle to match the brand. */
export function renderEmail(options: RenderEmailOptions): { html: string; text: string } {
  const paragraphs = options.body
    .map((entry) => {
      if (typeof entry === 'string') {
        return `<p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;">${escapeHtml(entry)}</p>`;
      }
      if (entry.kind === 'link') {
        return `<p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;"><a href="${escapeHtml(entry.href)}" style="color:#1f2933;text-decoration:underline;">${escapeHtml(entry.text)}</a></p>`;
      }
      if (entry.kind === 'chip') {
        // Render the chip + a static trailing line. We deliberately
        // do NOT wrap a `{kind:'link'}` link in the same paragraph —
        // a `<span><a>` pair nested inside a chip row renders with
        // mail-client quirks (Gmail clips, Outlook adds line-breaks).
        // The chip's color spans are positioned via inline `style` so
        // the email-client CSS-engine doesn't drop them.
        return `<p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;"><span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${escapeHtml(entry.bg)};color:${escapeHtml(entry.fg)};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;vertical-align:middle;">${escapeHtml(entry.text)}</span></p>`;
      }
      if (entry.kind === 'day') {
        // Heading variant — bumped weight and 24px top-margin so it
        // separates visually from the prior block's 16px bottom-margin.
        return `<p style="margin:24px 0 8px;color:#111111;font-size:16px;font-weight:600;">${escapeHtml(entry.label)}</p>`;
      }
      // Exhaustiveness — TypeScript narrows to `never` here so adding
      // a new entry kind fails compile at the union boundary.
      return '';
    })
    .join('');
  const button = options.cta
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(options.cta.url)}" style="display:inline-block;padding:10px 20px;background:#111111;color:#ffffff;text-decoration:none;font-size:15px;">${escapeHtml(options.cta.label)}</a></p>`
    : '';
  const footer = options.footer
    ? `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;color:#999999;font-size:12px;">${escapeHtml(options.footer)}</div>`
    : '';
  const html = [
    '<div style="max-width:560px;margin:0 auto;padding:24px;font-family:Arial,Helvetica,sans-serif;">',
    `<h1 style="margin:0 0 16px;color:#111111;font-size:22px;">${escapeHtml(options.heading)}</h1>`,
    paragraphs,
    button,
    footer,
    '</div>',
  ].join('');
  const textBody = options.body.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry.kind === 'day') return entry.label;
    if (entry.kind === 'chip') return `[${entry.text}]`;
    // link
    return `${entry.text} (${entry.href})`;
  });
  const text = [
    options.heading,
    '',
    ...textBody,
    ...(options.cta ? ['', `${options.cta.label}: ${options.cta.url}`] : []),
    ...(options.footer ? ['', options.footer] : []),
  ].join('\n');
  return { html, text };
}

// ─── Example templates — edit / add / remove to fit the app ───

/** Welcome email for a new signup. */
export function welcomeEmail(input: { name: string; ctaUrl?: string }): EmailContent {
  const { html, text } = renderEmail({
    heading: `Welcome, ${input.name}!`,
    body: ["Thanks for signing up — we're glad you're here."],
    cta: input.ctaUrl ? { label: 'Get started', url: input.ctaUrl } : undefined,
    footer: 'You received this because you created an account.',
  });
  return { subject: 'Welcome aboard', html, text };
}

/** Password reset email sent by Better Auth through the configured mail helper. */
export function passwordResetEmail(input: { resetUrl: string }): EmailContent {
  const { html, text } = renderEmail({
    heading: `Reset your ${brand.name} password`,
    body: [
      `We received a request to reset your ${brand.name} password.`,
      'This link expires in one hour and can only be used once.',
    ],
    cta: { label: 'Reset password', url: input.resetUrl },
    footer: 'If you did not request a password reset, you can ignore this email.',
  });
  return { subject: 'Reset your password', html, text };
}

/** Generic notification email. */
export function notificationEmail(input: {
  subject: string;
  title: string;
  lines: string[];
  cta?: { label: string; url: string };
}): EmailContent {
  const { html, text } = renderEmail({ heading: input.title, body: input.lines, cta: input.cta });
  return { subject: input.subject, html, text };
}

/** Handoff-note email — fired when a teammate posts an AlertNote on an
 *  alert owned by someone else. Distinct from `alertEmail` (a brand-new
 *  severity-and-finding blast): this is a colleague-driven follow-up,
 *  not a scan-firing event. Subject is the joined `findingTitle`
 *  (rendered raw — caller passes `VulnerabilityFinding.cveId`, the
 *  precedent used by `alertDigestEmail`'s per-row text and by
 *  `business/alerts-dispatch.ts:130` `titleByFindingId`); swap to the
 *  `[severity] ${findingTitle}` shape from `alertEmail` if the brief
 *  asks.
 *
 *  `noteBody` is the raw 1–500 char persisted body (zod-validated by
 *  `AlertNoteCreateBody`); we pass it RAW into `renderEmail` so the
 *  template's own `escapeHtml` runs — passing an already-escaped
 *  string would double-escape and the owner would see literal
 *  `&amp;` in their inbox.
 *
 *  No attachments, cc/bcc, or custom `from` — the proxy contract only
 *  accepts `to, subject, body/html, reply_to_email_id`; `from` is
 *  bound at the edge using fromFor('alerts') and overrides are
 *  rejected by `sendEmail()`.
 */
export function alertNoteEmail(input: {
  findingTitle: string;
  noteBody: string;
  authorEmail: string;
  ctaUrl: string;
}): EmailContent {
  const { html, text } = renderEmail({
    heading: `New note on ${input.findingTitle}`,
    body: [
      `${input.authorEmail} just posted a handoff note on this alert.`,
      '',
      'Note:',
      input.noteBody,
      'Open the alert notes pane to read the full thread.',
    ],
    cta: { label: 'View notes', url: input.ctaUrl },
    footer: "You're receiving this because a teammate just posted on an alert you own.",
  });
  return { subject: input.findingTitle, html, text };
}

/** Alert-resolved email — fired when a teammate (NOT the owner) marks an
 *  owned alert `resolved` on /alerts/[id]. Distinct from alertEmail (a
 *  brand-new scan-firing blast): this is a colleague-driven close, not a
 *  scan event. The firing check is owned by /api/alerts/[id]/resolve,
 *  which neighbour-reads the alert + AlertNote-thread watchers, dedupes
 *  by email, strips the resolver (`ctx.user.email`) from the list,
 *  then fire-and-forgets one envelope per recipient here.
 *
 *  Subject is verbatim `Your alert on {host} was resolved` per the
 *  brief — the host (asset hostname) is the canonical identifier an
 *  operator scans first in their inbox. `severity` is nullable on
 *  the row, so we fall back to `—` in the body. `closingNote` is
 *  optional (an emit-without-note resolve still ships this mail —
 *  the "I closed it" signal is what wakes the owner up, not the
 *  prose); when present it's appended as an extra paragraph so
 *  the reading order stays `severity → resolve-note → open-the-page`.
 *
 *  No attachments, cc/bcc, or custom `from` — the proxy binds those
 *  at the edge using fromFor('alerts'); sendEmail() intentionally
 *  rejects them.
 */
export function alertResolvedEmail(input: {
  host: string;
  severity: string | null;
  closingNote: string | null;
  ctaUrl: string;
}): EmailContent {
  const body: string[] = [`Severity: ${input.severity ?? '—'}.`];
  if (input.closingNote) {
    body.push(`Resolve note: ${input.closingNote}`);
  }
  body.push('Open the alert page to review the lifecycle and the resolved timeline.');
  const { html, text } = renderEmail({
    heading: `Alert resolved — ${input.host}`,
    body,
    cta: { label: 'View alert', url: input.ctaUrl },
    footer: `You're receiving this because you own (or have a handoff note on) this alert on ${brand.name}.`,
  });
  return { subject: `Your alert on ${input.host} was resolved`, html, text };
}

/** Scan-alert email — fired when a new alert row is created for a finding. */
export function alertEmail(input: {
  severity: string;
  findingTitle: string;
  ctaUrl: string;
}): EmailContent {
  const { html, text } = renderEmail({
    heading: `New ${input.severity} alert`,
    body: [
      `A finding was just opened: ${input.findingTitle}.`,
      'Open the finding page for the full evidence, affected assets, and remediation guidance.',
    ],
    cta: { label: 'View finding', url: input.ctaUrl },
    footer: "You're receiving this because you're subscribed to scan alerts on this team.",
  });
  return { subject: `[${input.severity}] ${input.findingTitle}`, html, text };
}

/** Vulnerability notification email — CVE/feed-driven intel updates. */
export function vulnNotificationEmail(input: {
  cveId: string;
  severity: string;
  summaryUrl: string;
}): EmailContent {
  const { html, text } = renderEmail({
    heading: `${input.cveId} — ${input.severity}`,
    body: [
      `A new or updated vulnerability matches your watched feeds.`,
      'Open the summary for the rewritten description, affected versions, and exploit context.',
    ],
    cta: { label: 'Read summary', url: input.summaryUrl },
    footer: "You're receiving this because your team subscribes to vulnerability notifications.",
  });
  return { subject: `${input.cveId} (${input.severity})`, html, text };
}

/** Team-invite email — fired when an admin creates a new invite row. */
export function teamInviteEmail(input: {
  orgName: string;
  inviterEmail: string;
  inviteUrl: string;
}): EmailContent {
  const { html, text } = renderEmail({
    heading: `You've been invited to ${input.orgName}`,
    body: [
      `${input.inviterEmail} just invited you to join ${input.orgName} on ${brand.name}.`,
      'Accept the invitation to get access to scans, findings, and team alerts.',
    ],
    cta: { label: 'Accept invitation', url: input.inviteUrl },
    footer: 'If you did not expect this invitation you can safely ignore this email.',
  });
  return { subject: `You're invited to ${input.orgName}`, html, text };
}

/** Invite-accepted confirmation — fired right after the recipient converts
 *  an invite token into a Membership. Confirms the join so they trust the
 *  dashboard they're about to land on; CTA points at /dashboard.
 */
export function inviteAcceptedEmail(input: {
  orgName: string;
  dashboardUrl: string;
}): EmailContent {
  const { html, text } = renderEmail({
    heading: `You've joined ${input.orgName}`,
    body: [
      `You're now a member of ${input.orgName} on ${brand.name}.`,
      'Open the dashboard to review scans, findings, and team alerts — invite teammates from inside the workspace when you are ready.',
    ],
    cta: { label: 'Open dashboard', url: input.dashboardUrl },
    footer: 'You received this because you accepted an invitation to this team.',
  });
  return { subject: `You've joined ${input.orgName}`, html, text };
}

/** Trial-first-scan nudge — single reminder to trial owners who signed up
 * but have not run their first scan 24h later. Soft tone ("your first scan
 * is the fastest way to see the platform in action"), not alarmist — the
 * workspace is theirs, they can run it when ready.
 */
export function trialFirstScanNudgeEmail(input: {
  name: string;
  dashboardUrl: string;
}): EmailContent {
  const { html, text } = renderEmail({
    heading: `Ready to run your first scan, ${input.name}?`,
    body: [
      `If you haven't had a chance yet, kicking off your first scan is the fastest way to see ${brand.name} in action against your own assets.`,
      'Open the dashboard and start a scan whenever it suits you — results stream in as findings come back.',
    ],
    cta: { label: 'Run your first scan', url: input.dashboardUrl },
    footer: 'This is a one-time nudge — no further action is required.',
  });
  return { subject: `Run your first ${brand.name} scan`, html, text };
}

/** Daily alert digest — one envelope per workspace per UTC day, fired by
 *  jobs/alert-digest.ts. Aggregates the last 24h of severity IN
 *  ('critical','high') AND acknowledgedAt IS NULL Alert rows into a single
 *  list with top-N assets by frequency and a CTA pointing at the most
 *  recent item. Drives user.recipients from the workspace roster.
 *  `alertCount` is the count of items the digest built (excludes zero-day
 *  all-clear envelopes, which call alertAllClearEmail below).
 *  No attachments, cc/bcc, or custom `from` — the proxy binds those at the
 *  edge using fromFor('alerts'); sendEmail() intentionally rejects them.
 */
export function alertDigestEmail(input: {
  teamName: string;
  winStartIso: string;
  winEndIso: string;
  alertCount: number;
  topAssets: string[];
  items: { id: string; severity: string; cveId: string; host: string; url: string }[];
  ctaUrl: string;
}): EmailContent {
  const winStart = input.winStartIso.slice(0, 16).replace('T', ' ');
  const winEnd = input.winEndIso.slice(0, 16).replace('T', ' ');
  const topAssetsLine = input.topAssets.length
    ? `Top assets: ${input.topAssets.join(', ')}.`
    : 'No asset hotspots to highlight.';
  const itemBodies: (string | EmailLink)[] = input.items.map((item) => ({
    kind: 'link',
    text: `[${item.severity}] on ${item.host} — ${item.cveId}`,
    href: item.url,
  }));
  const { html, text } = renderEmail({
    heading: `Daily alert digest — ${input.alertCount} open critical/high ${input.alertCount === 1 ? 'item' : 'items'}`,
    body: [
      `Workspace: ${input.teamName}.`,
      `Window: ${winStart} UTC → ${winEnd} UTC.`,
      topAssetsLine,
      ...itemBodies,
      'Open the digest CTA below for the most-recent item — every row above links back to its alert page from the /alerts queue so a teammate can pick up where this digest leaves off.',
    ],
    cta: { label: 'View most-recent alert', url: input.ctaUrl },
    footer:
      "You're receiving this because you're an active member of this workspace. The workspace admin can pause the daily digest from the team settings page.",
  });
  return {
    subject: `[digest] ${input.alertCount} open critical/high alerts in ${input.teamName}`,
    html,
    text,
  };
}

/** All-clear branch of the daily digest — fires when a workspace has at
 *  least one active member but ZERO matching critical/high unack'd alerts
 *  in the last 24h. Short, single paragraph, NO CTA so the team is
 *  reassured without being routed to a list page they don't need.
 *  Subject prefix matches the digest subject so the team learns the
 *  pattern: a daily mail either summarises alerts or confirms a clean
 *  window.
 */
export function alertAllClearEmail(input: {
  teamName: string;
  winStartIso: string;
  winEndIso: string;
}): EmailContent {
  const winStart = input.winStartIso.slice(0, 16).replace('T', ' ');
  const winEnd = input.winEndIso.slice(0, 16).replace('T', ' ');
  const { html, text } = renderEmail({
    heading: `Daily alert digest — all clear`,
    body: [
      `Workspace: ${input.teamName}.`,
      `Window: ${winStart} UTC → ${winEnd} UTC.`,
      'No open critical or high-severity alerts in the last 24 hours.',
      "Tomorrow's digest will run on the same schedule — if a new critical or high alert lands, it will surface there. Open /alerts anytime to review the broader queue.",
    ],
    footer:
      "You're receiving this because you're an active member of this workspace. The workspace admin can pause the daily digest from the team settings page.",
  });
  return { subject: `[digest] all clear in ${input.teamName}`, html, text };
}

/** 09:00 UTC daily alert digest — one envelope per workspace per UTC
 *  day, fired by jobs/daily-alert-digest.ts. Aggregates the last 24h
 *  of every-severity Alert rows that were either CREATED or had their
 *  status CHANGE in the window into a per-severity count summary with
 *  per-row `{kind:'link'}` anchors pointing at /alerts?ownedByMe=1. The
 *  brief says "deep links back to /alerts?ownedByMe=1": the
 *  /alerts page already reads `?ownedByMe=1` and lights the "Owned by me"
 *  chip (mirror src/app/(dashboard)/alerts/page.tsx:194) and the
 *  /api/alerts handler narrows server-side when ?ownedByMe=1 is set
 *  (src/app/api/alerts/route.ts:64-80).
 *
 *  Distinct from alertDigestEmail (07:00 nightly):
 *    - Covers ALL severities (critical/high/medium/low), grouped by
 *      `prisma.alert.groupBy` and rendered as 4 labeled count lines.
 *    - Uses 'created OR status-changed in the last 24h' instead of
 *      'critical/high + unack'd' — see business lib for the exact
 *      Prisma filter shape.
 *    - Per-row deep link target is the workspace /alerts page filtered
 *      by ?ownedByMe=1, not the /alerts/[id] detail page.
 *
 *  Subject prefix `[daily digest]` matches the existing `[digest]` /
 *  `[weekly digest]` cadence.
 */
export function dailyAlertDigestEmail(input: {
  teamName: string;
  winStartIso: string;
  winEndIso: string;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  items: { id: string; severity: string; cveId: string; host: string; url: string }[];
  ctaUrl: string;
}): EmailContent {
  const winStart = input.winStartIso.slice(0, 16).replace('T', ' ');
  const winEnd = input.winEndIso.slice(0, 16).replace('T', ' ');
  const totalItems =
    input.severityCounts.critical +
    input.severityCounts.high +
    input.severityCounts.medium +
    input.severityCounts.low;
  const countsLabel = (label: string, n: number) => (n === 0 ? `${label}: 0` : `${label}: ${n}`);
  const itemBodies: (string | EmailLink)[] = input.items.map((item) => ({
    kind: 'link',
    text: `[${item.severity}] on ${item.host} — ${item.cveId}`,
    href: item.url,
  }));
  const { html, text } = renderEmail({
    heading: `[daily digest] ${totalItems} ${totalItems === 1 ? 'item' : 'items'} in last 24h`,
    body: [
      `Workspace: ${input.teamName}.`,
      `Window: ${winStart} UTC → ${winEnd} UTC.`,
      countsLabel('Critical', input.severityCounts.critical),
      countsLabel('High', input.severityCounts.high),
      countsLabel('Medium', input.severityCounts.medium),
      countsLabel('Low', input.severityCounts.low),
      ...itemBodies,
      'Every row above links back to the workspace /alerts queue already filtered to items owned by you — open any row to triage from the alert detail page.',
    ],
    cta: { label: 'Open /alerts', url: input.ctaUrl },
    footer:
      "You're receiving this because you're an active member of this workspace. The workspace admin can pause the daily digest from the team settings page.",
  });
  return {
    subject: `[daily digest] ${totalItems} ${totalItems === 1 ? 'item' : 'items'} in ${input.teamName}`,
    html,
    text,
  };
}

/** All-clear branch of the 09:00 daily digest — fires when a workspace
 *  has at least one active member but ZERO matching created-OR-status-
 *  changed alert rows in the last 24h. Short, single paragraph, NO CTA
 *  so the team is reassured without being routed to a list page they
 *  don't need. Subject prefix `[daily digest]` keeps the cadence
 *  obvious next to the nightly and weekly digests in a busy inbox.
 */
export function dailyAlertAllClearEmail(input: {
  teamName: string;
  winStartIso: string;
  winEndIso: string;
}): EmailContent {
  const winStart = input.winStartIso.slice(0, 16).replace('T', ' ');
  const winEnd = input.winEndIso.slice(0, 16).replace('T', ' ');
  const { html, text } = renderEmail({
    heading: `[daily digest] all clear`,
    body: [
      `Workspace: ${input.teamName}.`,
      `Window: ${winStart} UTC → ${winEnd} UTC.`,
      'No alerts created or status-changed in the last 24 hours.',
      "Tomorrow's daily digest will run on the same schedule — if anything lands, it will surface there. Open /alerts anytime to review the broader queue.",
    ],
    footer:
      "You're receiving this because you're an active member of this workspace. The workspace admin can pause the daily digest from the team settings page.",
  });
  return { subject: `[daily digest] all clear in ${input.teamName}`, html, text };
}

/** Inbound contact form submission — fired by `POST /api/contact` when a
 *  visitor fills the public /contact form. The full payload lands in the
 *  body (name / work email / optional company / message) plus a triage
 *  footer (submittedAt + userAgent so whoever picks it up can correlate
 *  browser headers against the inbound IP at the platform edge).
 *
 *  We deliberately render the field values as plain strings (not, say,
 *  `{kind:'link'}`) so `renderEmail`'s own `escapeHtml` runs — passing an
 *  already-escaped string would double-escape and the operator would see
 *  literal `&amp;` in their inbox.
 */
export function contactSubmissionEmail(input: {
  name: string;
  email: string;
  company?: string;
  message: string;
  submittedAt: string;
  userAgent: string;
  teamSize?: string;
}): EmailContent {
  const subject = `New contact form submission — ${input.name}${
    input.company ? ` (${input.company})` : ''
  }`;
  const submittedAtLine = `${input.submittedAt.slice(0, 19).replace('T', ' ')} UTC`;
  const uaLine =
    input.userAgent.length > 200 ? `${input.userAgent.slice(0, 200)}…` : input.userAgent;
  const body: string[] = [
    `Name: ${input.name}`,
    `Work email: ${input.email}`,
    input.company ? `Company: ${input.company}` : 'Company: —',
  ];
  if (input.teamSize) {
    body.push(`Team size: ${input.teamSize}`);
  }
  body.push(`Submitted: ${submittedAtLine}`, '', 'Message:', input.message);
  const { html, text } = renderEmail({
    heading: 'New contact form submission',
    body,
    footer: `User agent: ${uaLine}`,
  });
  return { subject, html, text };
}

/** Weekly AI-generated risk-trend digest — fired Monday 08:00 UTC by
 *  jobs/weekly-risk-digest.ts OR on-demand by /api/admin/digest/run. The
 *  body is the LLM-generated analyst summary (one or two paragraphs of
 *  prose); we pass raw strings into `renderEmail` so the template's own
 *  escapeHtml handles quoting. NO markdown→HTML conversion — the brief
 *  keeps the mail text-only and lets the model's plain prose land clean.
 *
 *  Subject prefix `[weekly digest]` keeps the cadence obvious in a
 *  busy inbox; the headline floats up to that prefix so the reader sees
 *  the meat on the subject line. The CTA points at the workspace's
 *  /dashboard so the admin lands in a context where they can drill in.
 */
export function weeklyRiskDigestEmail(input: {
  teamName: string;
  weekStartIso: string;
  weekEndIso: string;
  headline: string;
  body: string;
  topMovers: { cveId: string; delta: number }[];
  topCriticals: { cveId: string; host: string }[];
  ctaUrl: string;
}): EmailContent {
  const weekStart = input.weekStartIso.slice(0, 16).replace('T', ' ');
  const weekEnd = input.weekEndIso.slice(0, 16).replace('T', ' ');
  const moversLine = input.topMovers.length
    ? `Biggest movers: ${input.topMovers.map((m) => `${m.cveId} (${m.delta >= 0 ? '+' : ''}${m.delta})`).join(', ')}.`
    : 'No notable week-over-week CVE traffic shifts.';
  const criticalsLine = input.topCriticals.length
    ? `Top criticals still open: ${input.topCriticals.map((c) => `${c.cveId} on ${c.host}`).join(', ')}.`
    : 'No un-remediated critical CVEs on the active host inventory.';
  const { html, text } = renderEmail({
    heading: `Weekly risk digest — ${input.teamName}`,
    body: [
      `Workspace: ${input.teamName}.`,
      `Window: ${weekStart} UTC → ${weekEnd} UTC.`,
      moversLine,
      criticalsLine,
      '',
      input.body,
    ],
    cta: { label: 'Open dashboard', url: input.ctaUrl },
    footer:
      "You're receiving this because you're an active member of this workspace. The cadence is one email Monday morning UTC; your admin can trigger an extra send from the workspace digest page.",
  });
  return {
    subject: `[weekly digest] ${input.headline}`,
    html,
    text,
  };
}

/** 08:30 UTC per-user daily digest — fired by
 *  jobs/daily-user-digest.ts. One envelope per opted-in User per UTC
 *  day, scoped to alerts whose `ownerId` matches the recipient OR
 *  whose `ownerId` is NULL (unassigned work the user can pick up).
 *  Distinct from dailyAlertDigestEmail (09:00 per-team):
 *    - Per-user recipient (not per-team recipients array).
 *    - Subject has NO team suffix — the body carries the workspace
 *      name so the heading reads as "your team's alerts" without
 *      bloating the inbox subject line.
 *    - Per-row deep links point at `${base}/alerts/[id]` (the alert
 *      detail page), NOT at `${base}/alerts?ownedByMe=1` — the brief
 *      scopes each row to its own row, not the shared filter chip.
 *    - NO CTA button. Brief lists per-row deep links as the
 *      navigation surface; `ctaUrl` is kept in the contract so a
 *      future revision can add one without breaking callers.
 *    - NO all-clear branch. Brief scopes this digest to NEW alerts
 *      only; empty-day users are skipped by the cron selector
 *      (silently, with no envelope, no stamp advance).
 *
 *  Subject prefix `[daily digest]` matches the surrounding cadence
 *  so the reader learns the pattern alongside the 09:00 nightly and
 *  the weekly risk digest. `topItems` is the caller's already-capped
 *  selection (up to 5 critical + up to 5 high, ≤10 total). The caller
 *  pre-sorts the list; the template just renders it.
 *
 *  All inputs are passed RAW into renderEmail (which runs its own
 *  escapeHtml). Don't escapeHtml them here — that doubles the
 *  escaping.
 *
 *  No attachments, cc/bcc, or custom `from` — the proxy binds those
 *  at the edge using fromFor('digest'); sendEmail() intentionally
 *  rejects them.
 */
export function dailyUserDigestEmail(input: {
  teamName: string;
  winStartIso: string;
  winEndIso: string;
  totalItems: number;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  /** Per-row URLs are precomputed `${base}/alerts/${item.id}` by the
   *  selector — this template does not re-derive them. Caller passes
   *  up to 5 critical + up to 5 high, so the rendered list caps at
   *  10 even when the underlying alert window holds more rows. */
  topItems: { id: string; severity: string; cveId: string; host: string; url: string }[];
  /** Pass through so a future revision can add a CTA without
   *  breaking callers. Currently UNUSED by the rendered template —
   *  the brief lists per-row deep links as the navigation surface. */
  ctaUrl: string;
}): EmailContent {
  const winStart = input.winStartIso.slice(0, 16).replace('T', ' ');
  const winEnd = input.winEndIso.slice(0, 16).replace('T', ' ');
  const countsLabel = (label: string, n: number) => (n === 0 ? `${label}: 0` : `${label}: ${n}`);
  const itemBodies: (string | EmailLink)[] = input.topItems.map((item) => ({
    kind: 'link',
    text: `[${item.severity}] on ${item.host} — ${item.cveId}`,
    href: item.url,
  }));
  const { html, text } = renderEmail({
    heading: `[daily digest] ${input.totalItems} new alert${input.totalItems === 1 ? '' : 's'} in last 24h`,
    body: [
      `Workspace: ${input.teamName}.`,
      `Window: ${winStart} UTC → ${winEnd} UTC.`,
      countsLabel('Critical', input.severityCounts.critical),
      countsLabel('High', input.severityCounts.high),
      countsLabel('Medium', input.severityCounts.medium),
      countsLabel('Low', input.severityCounts.low),
      ...itemBodies,
      'Every row above links back to its own alert detail page so you can pick up where this digest leaves off.',
    ],
    footer:
      "You're receiving this because you opted into the per-user daily digest. Opt out anytime from /account.",
  });
  return {
    subject: `[daily digest] ${input.totalItems} ${input.totalItems === 1 ? 'item' : 'items'} in the last 24h`,
    html,
    text,
  };
}

/**
 * On-demand snooze digest — one envelope per call, fired by
 * POST /api/alerts/snooze-digest (and reusable by a future cron
 * trigger). Summarises the alerts the calling user has snoozed
 * AND currently owns, bucketed by the UTC calendar day of
 * `snoozedUntil`. Each row renders as a `<` {kind:'chip'}
 * severity chip followed by a deep link to /alerts/[id] and a
 * short hours-remaining hint. Subject prefix
 * `[snooze digest]` keeps it inline with the surrounding
 * `[daily digest]` and `[weekly digest]` cadence in a busy inbox.
 *
 * Two deltas vs. dailyUserDigestEmail / dailyAlertDigestEmail:
 *   - Per-day bucket headings (`{kind:'day'}`) inside the body
 *     vector — separates today's bucket ("Today (N)") from prior
 *     buckets ("Yesterday (N)", "YYYY-MM-DD (N)"). Today first so
 *     the freshest rows surface at the top of the email.
 *   - Per-row severity CHIP (`{kind:'chip'}`) alongside the deep
 *     link — the on-page badge variant mapping (critical/high red,
 *     medium amber, default slate) is mirrored inline-styled so
 *     Gmail/Outlook don't drop the styling.
 *
 * Reusable template structure: the
 * `findSnoozeDigestInput(userId, now)` + `groupSnoozeByDay(items, now)`
 * + `snoozeDigestEmail(input)` triplet is the same shape the
 * future cron-job reuser runs without rework — only the
 * selector's caller loops per Membership row.
 */
export function snoozeDigestEmail(input: {
  teamName: string;
  /** Per-day buckets in display order (today's bucket first, prior
   *  days desc). Each bucket carries a `dayLabel` ("Today (N)" or
   *  "Yesterday (N)" or "YYYY-MM-DD (N)") and the per-row shape
   *  the chip + link renderer reads. */
  groups: {
    dayLabel: string;
    items: {
      id: string;
      severity: string;
      cveId: string;
      host: string;
      /** Precomputed `${appBaseUrl}/alerts/${id}` so the template
       *  does not re-derive the URL. Set by the sender, not the
       *  pure `findSnoozeDigestInput` selector. */
      url: string;
      /** Hours-remaining label, precomputed by the selector from
       *  `snoozedUntil` so the body carries a single value per row. */
      untilInHours: number;
    }[];
  }[];
}): EmailContent {
  // Severity → chip color map mirroring the on-page Alert table's
  // `severityVariant` (Badge variant). High & critical pair against
  // red-700ish (#b91c1c); medium pairs against amber-800ish
  // (#92400e); low / undefined / unknown pair with slate (#374151).
  const chipColor = (severity: string): { bg: string; fg: string } => {
    const s = severity.toLowerCase();
    if (s === 'critical' || s === 'high') return { bg: '#b91c1c', fg: '#ffffff' };
    if (s === 'medium') return { bg: '#92400e', fg: '#ffffff' };
    return { bg: '#374151', fg: '#ffffff' };
  };

  const totalItems = input.groups.reduce((sum, g) => sum + g.items.length, 0);
  // Empty-envelope guard — caller-side pre-flight handles this but
  // a future cron could loop this template directly; defend by
  // returning a no-render shape so the email body never ships a
  // header-only mail.
  const heading =
    totalItems === 0
      ? `[snooze digest] no snoozed alerts in ${input.teamName}`
      : `[snooze digest] ${totalItems} snoozed alert${totalItems === 1 ? '' : 's'} in ${input.teamName}`;

  const body: (string | EmailLink | EmailChip | EmailDay)[] = [
    `Team: ${input.teamName}.`,
    'Today is grouped first; earlier days follow in reverse order.',
  ];

  if (totalItems === 0) {
    body.push('No alerts are snoozed at this moment. Open /alerts anytime to triage your queue.');
  } else {
    for (const group of input.groups) {
      body.push({ kind: 'day', label: group.dayLabel });
      for (const item of group.items) {
        body.push({ kind: 'chip', text: item.severity, ...chipColor(item.severity) });
        const cveId = item.cveId || 'unknown';
        const host = item.host || '—';
        // Hours-remaining hint: "snoozed for X more hours" for X > 0;
        // out-of-window (e.g. the `snoozedUntil > now-24h` lower bound
        // resurfaces a "few minutes remaining" row when the window is
        // a few minutes from expiring). Floor rounded so a 4h 50m window
        // reads as "4 hours remaining" rather than "5 hours remaining".
        const hours = item.untilInHours;
        const hint =
          hours > 0
            ? `${hours} more ${hours === 1 ? 'hour' : 'hours'} until it returns to your queue`
            : 'returns to your queue with the next refresh';
        body.push({
          kind: 'link',
          text: `[${item.severity}] on ${host} — ${cveId} — ${hint}`,
          href: item.url,
        });
      }
    }
  }

  const { html, text } = renderEmail({
    heading,
    body,
    footer:
      "You're receiving this because you own these snoozed alerts. Open /alerts anytime to review the full queue.",
  });
  return {
    subject: heading,
    html,
    text,
  };
}
