// Inline alert-status coverage shared by the desktop table and mobile cards.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ALERT_STATUS_OPTIONS } from '@/components/custom/alert-status-control';
import { AlertsListStatus } from '@/components/dashboard/alerts-list-status';
import { AlertsListCards } from '@/components/dashboard/alerts-list-cards';
import { applyAlertStatusMutation } from '@/lib/business/alerts-status-reconcile';
import type { AlertItem, AlertStatusMutationResponse } from '@/lib/contracts/alerts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  return container;
}

function makeItem(id: string, overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id,
    teamId: 'team-1',
    findingId: `finding-${id}`,
    severity: 'high',
    status: 'open',
    source: 'manual',
    assigneeId: null,
    ownerId: null,
    ownerName: null,
    createdAt: '2026-11-18T10:00:00.000Z',
    acknowledgedAt: null,
    snoozedUntil: null,
    cveId: 'CVE-2026-90001',
    vulnerabilityTitle: null,
    asset: { host: 'api.example.test', port: 443, protocol: 'https' },
    falsePositiveReason: null,
    closingNote: null,
    remediatedAt: null,
    remediatedByEmail: null,
    lastActivityAt: null,
    lastExplainedAt: null,
    lastExplanationText: null,
    ...overrides,
  };
}

function makeSaved(overrides: Partial<AlertStatusMutationResponse> = {}): AlertStatusMutationResponse {
  return {
    id: 'alert-1',
    status: 'resolved',
    statusChangedAt: '2026-11-18T11:00:00.000Z',
    acknowledgedAt: null,
    closedAt: '2026-11-18T11:00:00.000Z',
    closedBy: 'user-1',
    closingNote: 'Patch shipped',
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    falsePositiveReason: null,
    snoozedUntil: null,
    ...overrides,
  };
}

describe('inline alert status editing', () => {
  it('offers exactly the four persisted statuses and excludes derived Snoozed', () => {
    expect(ALERT_STATUS_OPTIONS).toEqual([
      { value: 'open', label: 'Open' },
      { value: 'in_progress', label: 'In progress' },
      { value: 'resolved', label: 'Resolved' },
      { value: 'false_positive', label: 'False positive' },
    ]);
  });

  it('renders a mobile card status control and its resolved note from the row', async () => {
    const host = await render(
      <AlertsListCards
        items={[makeItem('alert-1', { status: 'resolved', closingNote: 'Patch shipped' })]}
        onStatusSaved={() => {}}
      />,
    );

    expect(host.querySelector('[aria-label="Alert status for alert-1"]')).not.toBeNull();
    expect(host.textContent).toContain('Resolution note: Patch shipped');
  });

  it('reconciles status details from the saved response on only the matching list item', () => {
    const target = makeItem('alert-1', {
      falsePositiveReason: 'old reason',
      closingNote: 'old note',
    });
    const other = makeItem('alert-2');
    const result = applyAlertStatusMutation([target, other], makeSaved());

    expect(result[0]).toMatchObject({
      id: 'alert-1',
      status: 'resolved',
      acknowledgedAt: null,
      snoozedUntil: null,
      falsePositiveReason: null,
      closingNote: 'Patch shipped',
    });
    expect(result[0]).not.toBe(target);
    expect(result[1]).toBe(other);
  });
});
