// @polsia:user-owned — Maps inclusive alert calendar dates to a Prisma range.
import { isCalendarDateString } from '@/lib/contracts/alert-date-range';

export interface AlertCreatedAtRange {
  gte?: Date;
  lt?: Date;
  lte?: Date;
}

export function buildAlertCreatedAtRange(
  from?: string,
  to?: string,
): AlertCreatedAtRange | undefined {
  if (!from && !to) return undefined;

  const range: AlertCreatedAtRange = {};
  if (from) range.gte = new Date(from);
  if (to) {
    if (isCalendarDateString(to)) {
      const nextDay = new Date(`${to}T00:00:00.000Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      range.lt = nextDay;
    } else {
      range.lte = new Date(to);
    }
  }
  return range;
}
