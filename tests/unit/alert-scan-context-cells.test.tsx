import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AlertScanContextCells,
  AlertScanContextSummary,
} from '@/components/dashboard/alert-scan-context-cells';

function renderCells(props: {
  latestScanAt: string | null;
  latestScanStatus: 'queued' | 'running' | 'completed' | 'failed' | null;
  hasCompletedScan: boolean;
}): HTMLElement {
  const container = document.createElement('table');
  container.innerHTML = renderToStaticMarkup(<AlertScanContextCells {...props} />);
  return container;
}

function renderSummary(props: {
  latestScanAt: string | null;
  latestScanStatus: 'queued' | 'running' | 'completed' | 'failed' | null;
  hasCompletedScan: boolean;
}): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<AlertScanContextSummary {...props} />);
  return container;
}

describe('AlertScanContextCells', () => {
  it('shows the latest completed scan timestamp and status', () => {
    const latestScanAt = '2026-09-01T11:30:00.000Z';
    const container = renderCells({
      latestScanAt,
      latestScanStatus: 'completed',
      hasCompletedScan: true,
    });

    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(latestScanAt);
    expect(container.textContent).toContain('completed');
    expect(container.textContent).not.toContain('context unavailable');

    const mobileSummary = renderSummary({
      latestScanAt,
      latestScanStatus: 'completed',
      hasCompletedScan: true,
    });
    expect(mobileSummary.querySelector('time')?.getAttribute('dateTime')).toBe(latestScanAt);
    expect(mobileSummary.textContent).toContain('completed');
    expect(mobileSummary.textContent).not.toContain('context unavailable');
  });

  it('keeps a failed latest attempt visible and marks completed context unavailable', () => {
    const latestScanAt = '2026-09-01T11:30:00.000Z';
    const container = renderCells({
      latestScanAt,
      latestScanStatus: 'failed',
      hasCompletedScan: false,
    });

    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(latestScanAt);
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('Completed scan context unavailable');

    const mobileSummary = renderSummary({
      latestScanAt,
      latestScanStatus: 'failed',
      hasCompletedScan: false,
    });
    expect(mobileSummary.querySelector('time')?.getAttribute('dateTime')).toBe(latestScanAt);
    expect(mobileSummary.textContent).toContain('failed');
    expect(mobileSummary.textContent).toContain('Completed scan context unavailable');
  });

  it('labels the time and status when no scan has been recorded', () => {
    const container = renderCells({
      latestScanAt: null,
      latestScanStatus: null,
      hasCompletedScan: false,
    });

    expect(container.textContent).toContain('No scan recorded');
    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).toContain('Completed scan context unavailable');
  });
});
