// @polsia:user-owned — Shared creation-age display for desktop and mobile alert rows.
'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function parseCreatedAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function formatRelativeAge(timestamp: Date, now: number): string {
  const deltaSeconds = Math.round((timestamp.getTime() - now) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  if (absoluteSeconds < 45) return RELATIVE_TIME_FORMATTER.format(deltaSeconds, 'second');
  if (absoluteSeconds < 45 * 60)
    return RELATIVE_TIME_FORMATTER.format(Math.round(deltaSeconds / 60), 'minute');
  if (absoluteSeconds < 22 * 60 * 60)
    return RELATIVE_TIME_FORMATTER.format(Math.round(deltaSeconds / 3600), 'hour');
  if (absoluteSeconds < 26 * 24 * 60 * 60)
    return RELATIVE_TIME_FORMATTER.format(Math.round(deltaSeconds / 86_400), 'day');
  if (absoluteSeconds < 320 * 24 * 60 * 60)
    return RELATIVE_TIME_FORMATTER.format(Math.round(deltaSeconds / (7 * 86_400)), 'week');
  if (absoluteSeconds < 365 * 24 * 60 * 60)
    return RELATIVE_TIME_FORMATTER.format(Math.round(deltaSeconds / (30 * 86_400)), 'month');
  return RELATIVE_TIME_FORMATTER.format(Math.round(deltaSeconds / (365 * 86_400)), 'year');
}

export function formatAlertCreatedAt(value: string | null | undefined): string | null {
  const timestamp = parseCreatedAt(value);
  return timestamp ? timestamp.toLocaleString() : null;
}

export function AlertAge({
  createdAt,
  now,
  className,
}: {
  createdAt: string | null | undefined;
  now: number;
  className?: string;
}) {
  const timestamp = parseCreatedAt(createdAt);
  if (!timestamp || !createdAt) {
    return <span className={className}>Unknown</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Alert created ${createdAt}`}
          className={`inline-flex cursor-help border-0 bg-transparent p-0 text-inherit underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${className ?? ''}`}
        >
          {formatRelativeAge(timestamp, now)}
        </button>
      </TooltipTrigger>
      <TooltipContent className="font-mono">{createdAt}</TooltipContent>
    </Tooltip>
  );
}
