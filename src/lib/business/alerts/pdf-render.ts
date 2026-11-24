// @polsia:user-owned — Alert data adapter for the governed PDF module.

import { ALERT_REMEDIATION_PROMPT_VERSION } from '@/lib/business/alert-remediation-guidance';
import type { DocumentSpec } from '@/lib/pdf/schema';

export interface AlertPdfAsset {
  host: string;
  ip: string;
  port: number;
  protocol: string;
  lastSeen: string | null;
}

export interface AlertPdfFixStep {
  title: string;
  body: string;
}

export interface AlertPdfNote {
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

export interface AlertPdfComment {
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface AlertPdfInput {
  brandName: string;
  teamName: string;
  generatedAt: string;
  createdAt: string;
  alertId: string;
  cveId: string;
  cvssScore: number | null;
  epssScore: number | null;
  description: string;
  severity: string | null;
  source: 'kev' | 'vulncheck' | 'manual';
  triggeredBy: 'ci-webhook' | 'scheduled' | 'manual' | null;
  status: 'open' | 'in_progress' | 'resolved' | 'false_positive';
  snoozedUntil: string | null;
  acknowledgedAt: string | null;
  remediatedAt: string | null;
  remediatedByEmail: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closingNote: string | null;
  falsePositiveReason: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  asset: AlertPdfAsset;
  notes: AlertPdfNote[];
  fixSteps: AlertPdfFixStep[];
  comments: AlertPdfComment[];
}

const EMPTY_GUIDANCE = 'No AI-generated remediation guidance is available for this alert.';

function display(value: string | number | null | undefined): string {
  if (value == null || String(value).trim() === '') return '—';
  return String(value);
}

function date(value: string | null): string {
  if (!value) return '—';
  return value
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
}

function sourceLabel(source: AlertPdfInput['source']): string {
  if (source === 'kev') return 'KEV';
  if (source === 'vulncheck') return 'VulnCheck';
  return 'Manual';
}

function triggerLabel(trigger: AlertPdfInput['triggeredBy']): string {
  if (trigger === 'ci-webhook') return 'CI webhook';
  if (trigger === 'scheduled') return 'Scheduled';
  return 'Manual';
}

function statusLabel(status: AlertPdfInput['status']): string {
  if (status === 'in_progress') return 'In progress';
  if (status === 'false_positive') return 'False positive';
  if (status === 'resolved') return 'Resolved';
  return 'Open';
}

/** Parse only the current persisted cache version and its array step shape. */
export function parseCachedAlertFixSteps(
  fixStepsJson: string | null | undefined,
  promptVersion: string | null | undefined,
): AlertPdfFixStep[] {
  if (!fixStepsJson || promptVersion !== ALERT_REMEDIATION_PROMPT_VERSION) return [];

  try {
    const decoded: unknown = JSON.parse(fixStepsJson);
    if (!Array.isArray(decoded)) return [];

    return decoded
      .filter((entry): entry is { id: string; title: string; body: string } => {
        if (!entry || typeof entry !== 'object') return false;
        const candidate = entry as { id?: unknown; title?: unknown; body?: unknown };
        return (
          typeof candidate.id === 'string' &&
          candidate.id.trim().length > 0 &&
          typeof candidate.title === 'string' &&
          candidate.title.trim().length > 0 &&
          typeof candidate.body === 'string' &&
          candidate.body.trim().length > 0
        );
      })
      .slice(0, 3)
      .map(({ title, body }) => ({ title: title.trim(), body: body.trim() }));
  } catch {
    return [];
  }
}

function supportingContext(input: AlertPdfInput): string {
  const notes = input.notes.length
    ? input.notes
        .map(
          (note) =>
            `- ${date(note.createdAt)} | ${display(note.authorEmail)}: ${display(note.body)}`,
        )
        .join('\n')
    : 'No alert notes.';
  const comments = input.comments.length
    ? input.comments
        .map(
          (comment) =>
            `- ${date(comment.createdAt)} | ${display(comment.authorName)}: ${display(comment.body)}`,
        )
        .join('\n')
    : 'No alert comments.';

  return `Supporting context\nNotes:\n${notes}\nComments:\n${comments}`;
}

/** Convert the alert projection into the module's validated document shape. */
export function mapAlertPdfDocument(input: AlertPdfInput): DocumentSpec {
  const guidance = input.fixSteps.length
    ? input.fixSteps.map((step, index) => `${index + 1}. ${step.title}\n${step.body}`).join('\n')
    : EMPTY_GUIDANCE;
  const owner = [input.ownerName, input.ownerEmail].filter(Boolean).join(' — ');

  return {
    title: `${display(input.brandName)} remediation brief`,
    subtitle: `Workspace: ${display(input.teamName)} | Alert: ${display(input.alertId)}`,
    meta: [
      { label: 'Alert ID', value: display(input.alertId) },
      { label: 'CVE', value: display(input.cveId) },
      { label: 'Severity', value: display(input.severity) },
      { label: 'Source', value: sourceLabel(input.source) },
      { label: 'Triggered by', value: triggerLabel(input.triggeredBy) },
      { label: 'CVSS', value: input.cvssScore == null ? '—' : input.cvssScore.toFixed(1) },
      { label: 'EPSS', value: input.epssScore == null ? '—' : input.epssScore.toFixed(3) },
      { label: 'Status', value: statusLabel(input.status) },
      { label: 'Created', value: date(input.createdAt) },
      { label: 'Host', value: display(input.asset.host) },
      { label: 'IP', value: display(input.asset.ip) },
      {
        label: 'Port / protocol',
        value: `${display(input.asset.port)} / ${display(input.asset.protocol)}`,
      },
      { label: 'Last seen', value: date(input.asset.lastSeen) },
      { label: 'Owner', value: display(owner) },
      { label: 'Acknowledged', value: date(input.acknowledgedAt) },
      { label: 'Snoozed until', value: date(input.snoozedUntil) },
      { label: 'Remediated', value: date(input.remediatedAt) },
      { label: 'Remediated by', value: display(input.remediatedByEmail) },
      { label: 'Closed', value: date(input.closedAt) },
      { label: 'Closed by', value: display(input.closedBy) },
      { label: 'Closing note', value: display(input.closingNote) },
      { label: 'False-positive reason', value: display(input.falsePositiveReason) },
      { label: 'Reopened', value: date(input.reopenedAt) },
      { label: 'Reopened by', value: display(input.reopenedBy) },
      { label: 'Reopen reason', value: display(input.reopenReason) },
      { label: 'Generated', value: date(input.generatedAt) },
    ],
    notes: [
      `Vulnerability description\n${display(input.description)}`,
      supportingContext(input),
      `AI-generated remediation guidance\n${guidance}`,
      'This guidance is informational only and does not confirm that remediation was applied.',
    ].join('\n\n'),
    footer:
      'Generated from the alert record. AI-generated guidance is informational only; no remediation outcome is asserted.',
  };
}

export { EMPTY_GUIDANCE };
