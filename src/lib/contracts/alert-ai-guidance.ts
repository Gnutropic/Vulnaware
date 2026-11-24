// @polsia:user-owned — Shared contract for alert priority and remediation explanations.

import { z } from 'zod';

export const AlertGuidanceMissingField = z.enum([
  'cve',
  'description',
  'severity',
  'priority',
  'asset',
]);

export const AlertGuidanceContent = z.object({
  priorityRationale: z.string().trim().min(1).max(900),
  remediationExplanation: z.string().trim().min(1).max(1200),
});

export const AlertGuidanceResponse = AlertGuidanceContent.extend({
  alertId: z.string(),
  generatedAt: z.string().datetime(),
  model: z.string().nullable(),
});
export type AlertGuidanceResponse = z.infer<typeof AlertGuidanceResponse>;

export const AlertGuidanceDraft = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    ...AlertGuidanceContent.shape,
  }),
  z.object({
    status: z.literal('insufficient_context'),
    missing: z.array(AlertGuidanceMissingField).min(1).max(5),
  }),
]);

export const AlertGuidanceUnavailable = z.object({
  error: z.enum(['not_found', 'insufficient_context', 'unavailable']),
  missing: z.array(AlertGuidanceMissingField).optional(),
});
export type AlertGuidanceUnavailable = z.infer<typeof AlertGuidanceUnavailable>;
