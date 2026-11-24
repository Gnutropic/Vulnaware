// @polsia:user-owned — Shared validation for calendar-date alert filters.
import { z } from 'zod';

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDateString(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const CalendarDate = z
  .string()
  .regex(CALENDAR_DATE_PATTERN, 'Use a YYYY-MM-DD calendar date.')
  .refine(isCalendarDateString, 'Enter a valid calendar date.');

// Keep accepting explicit ISO timestamps for existing API links while
// rejecting ambiguous browser-local timestamps and Date.parse fallbacks.
export const AlertDateBound = z.union([CalendarDate, z.string().datetime({ offset: true })]);

export function isAlertDateRangeOrdered(from?: string, to?: string): boolean {
  if (!from || !to) return true;
  return Date.parse(from) <= Date.parse(to);
}
