// @polsia:user-owned — small client-only pulse for the hero "live SOC" panel.

'use client';

import { cn } from '@/lib/utils';

export function LivePulse({ className }: { className?: string }) {
  return (
    <span
      className={cn('relative inline-flex size-2 items-center justify-center', className)}
      aria-hidden
    >
      <span className="absolute inset-0 animate-ping rounded-full bg-primary/70 opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  );
}
