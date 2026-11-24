// @polsia:user-owned — URL helpers shared by the alert list and detail pages.

export type AlertSearchParams = Readonly<Record<string, string | string[] | undefined>>;

export function buildAlertDetailHref(alertId: string, listQueryString: string): string {
  const query = listQueryString.replace(/^\?/, '');
  return `/alerts/${encodeURIComponent(alertId)}${query ? `?${query}` : ''}`;
}

export function buildAlertReturnHref(searchParams: AlertSearchParams): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') {
      query.append(key, value);
      continue;
    }

    for (const entry of value ?? []) {
      query.append(key, entry);
    }
  }

  const queryString = query.toString();
  return queryString ? `/alerts?${queryString}` : '/alerts';
}
