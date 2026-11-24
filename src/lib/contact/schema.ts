// @polsia:user-owned — shared zod contract for the public contact form.
// SAFE for client + server import: zod only, no server-only imports, so the
// form island can validate locally and the route handler can re-validate
// server-side on a single source of truth.

import { z } from 'zod';

/** Inbound shape for POST /api/contact.
 *
 *  `website` is a hidden honeypot — real users never see the field, but bots
 *  fill it in. The route treats any non-empty value as a bot, returns the
 *  standard 200 OK envelope (so bots can't tell), and skips the email send.
 */
export const contactSchema = z.object({
  name: z.string().min(1, 'Please enter your name.').max(120, 'Name is too long.'),
  email: z.string().email('Please enter a valid work email.').max(254, 'Email is too long.'),
  company: z
    .string()
    .max(120, 'Company name is too long.')
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  message: z
    .string()
    .min(1, 'Please enter a message.')
    .max(5000, 'Message is too long (5000 characters max).'),
  website: z.string().max(120).optional(),
  teamSize: z.string().max(40, 'Team size is too long.').optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;

/** Success response — 200 envelope couples to apiFetch's `schema` option. */
export const contactResponseSchema = z.object({
  ok: z.literal(true),
  sentAt: z.string().datetime(),
});

export type ContactResponse = z.infer<typeof contactResponseSchema>;
