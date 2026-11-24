// @polsia:user-owned
// Dedicated hostname search control for the /alerts list. The shared input
// owns the debounced URL write and clear behavior; this wrapper fixes the
// hostname-specific accessible copy and URL key at the call site.

'use client';

import { AlertsTextQueryInput } from '@/components/dashboard/alerts-text-query-input';

interface AlertsHostnameSearchInputProps {
  initialValue?: string;
}

export function AlertsHostnameSearchInput({ initialValue = '' }: AlertsHostnameSearchInputProps) {
  return (
    <AlertsTextQueryInput
      initialValue={initialValue}
      queryKey="hostname"
      inputId="alerts-hostname-search"
      label="Search alerts by asset hostname"
      placeholder="Search asset hostname…"
      clearLabel="Clear hostname search"
    />
  );
}
