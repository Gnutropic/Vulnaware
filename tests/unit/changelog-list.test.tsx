import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangelogList } from '@/components/custom/changelog/changelog-list';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock }));

beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterAll(() => vi.unstubAllGlobals());

const ENTRIES = [
  {
    id: 'resolved-alert-filter',
    title: 'Resolved-alert filter',
    body: 'Filter the alert list to resolved alerts.',
  },
  {
    id: 'asset-risk-score-trend',
    title: 'Asset risk-score trend',
    body: 'View an asset’s risk score over time.',
  },
  {
    id: 'dashboard-tiles',
    title: 'Dashboard tiles',
    body: 'Review product information in dashboard tiles.',
  },
  { id: 'pdf-export', title: 'PDF export', body: 'Export as a PDF.' },
  {
    id: 'snooze-summary-email-digest',
    title: 'Snooze-summary email digest',
    body: 'Receive an email digest summarizing snoozed alerts.',
  },
];

let container: HTMLDivElement;
let root: Root;
let resolvePendingRequest: ((payload: { entries: typeof ENTRIES }) => void) | undefined;

beforeEach(() => {
  apiFetchMock.mockReset();
  resolvePendingRequest = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderList() {
  await act(async () => {
    root.render(<ChangelogList />);
    await Promise.resolve();
  });
}

describe('ChangelogList', () => {
  it('renders the loaded entries, stable anchors, and Shipped marker without dates', async () => {
    apiFetchMock.mockResolvedValue({ entries: ENTRIES });
    await renderList();

    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelectorAll('h3').length).toBe(5);
    expect(container.textContent).toContain('Resolved-alert filter');
    expect(container.textContent).toContain('Receive an email digest summarizing snoozed alerts.');
    expect(container.querySelector('#entry-resolved-alert-filter')).not.toBeNull();
    expect(container.querySelectorAll('li').length).toBe(5);
    expect(container.textContent?.match(/Shipped/g)).toHaveLength(5);
    expect(container.querySelector('time')).toBeNull();
    expect(container.textContent).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  it('keeps an accessible loading state while the request is pending', async () => {
    apiFetchMock.mockImplementation(
      () =>
        new Promise<{ entries: typeof ENTRIES }>((resolve) => {
          resolvePendingRequest = resolve;
        }),
    );
    await renderList();

    expect(container.querySelector('output')?.textContent).toContain('Loading updates');
    await act(async () => {
      resolvePendingRequest?.({ entries: [] });
    });
  });

  it('keeps an accessible API error state', async () => {
    apiFetchMock.mockRejectedValue(new Error('Updates could not be loaded.'));
    await renderList();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Updates could not be loaded.',
    );
  });

  it('explains when the feed is empty', async () => {
    apiFetchMock.mockResolvedValue({ entries: [] });
    await renderList();

    expect(container.textContent).toContain('No updates yet.');
  });
});
