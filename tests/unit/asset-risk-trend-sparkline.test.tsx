// @vitest-environment jsdom
// @polsia:user-owned — Presentation coverage for the asset risk-trend summary.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRiskTrend } from '@/lib/contracts/assets-risk-trend';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock }));

import { AssetRiskTrendSparkline } from '@/components/dashboard/asset-risk-trend-sparkline';

const HOST = 'app.example.com';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  apiFetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderTrend(series: AssetRiskTrend['series']): Promise<HTMLElement> {
  apiFetchMock.mockResolvedValue({ host: HOST, series });
  await act(async () => {
    root.render(<AssetRiskTrendSparkline host={HOST} />);
    await Promise.resolve();
  });
  const summary = container.querySelector<HTMLElement>('[data-testid="asset-risk-trend-summary"]');
  if (!summary) throw new Error('Expected the risk-trend summary to render.');
  return summary;
}

describe('AssetRiskTrendSparkline summary', () => {
  it('shows labeled scores, a signed increase, and risk direction', async () => {
    const summary = await renderTrend([
      { scannedAt: '2026-09-01T12:00:00.000Z', score: 4.2 },
      { scannedAt: '2026-09-15T12:00:00.000Z', score: 5.1 },
      { scannedAt: '2026-09-30T12:00:00.000Z', score: 6.1 },
    ]);

    expect(summary.textContent).toContain('Baseline scan date');
    expect(summary.textContent).toContain('Baseline risk score4.20');
    expect(summary.textContent).toContain('Latest scan date');
    expect(summary.textContent).toContain('Latest risk score6.10');
    expect(
      summary.querySelector('[data-testid="asset-risk-baseline-date"]')?.getAttribute('datetime'),
    ).toBe('2026-09-01T12:00:00.000Z');
    expect(
      summary.querySelector('[data-testid="asset-risk-latest-date"]')?.getAttribute('datetime'),
    ).toBe('2026-09-30T12:00:00.000Z');
    expect(summary.textContent).toContain('Change+1.90 points');
    expect(summary.textContent).toContain('Risk increased');
  });

  it('shows a signed decrease and risk direction', async () => {
    const summary = await renderTrend([
      { scannedAt: '2026-09-01T12:00:00.000Z', score: 6.1 },
      { scannedAt: '2026-09-30T12:00:00.000Z', score: 4.2 },
    ]);

    expect(summary.textContent).toContain('Baseline risk score6.10');
    expect(summary.textContent).toContain('Latest risk score4.20');
    expect(summary.textContent).toContain('Change−1.90 points');
    expect(summary.textContent).toContain('Risk decreased');
  });

  it('shows no change with a zero-point delta', async () => {
    const summary = await renderTrend([
      { scannedAt: '2026-09-01T12:00:00.000Z', score: 4.2 },
      { scannedAt: '2026-09-30T12:00:00.000Z', score: 4.2 },
    ]);

    expect(summary.textContent).toContain('No change');
    expect(summary.textContent).toContain('Change0.00 points');
  });

  it('shows only the five most recent scores in newest-first order', async () => {
    await renderTrend([
      { scannedAt: '2026-09-01T12:00:00.000Z', score: 1.1 },
      { scannedAt: '2026-09-05T12:00:00.000Z', score: 2.2 },
      { scannedAt: '2026-09-10T12:00:00.000Z', score: 3.3 },
      { scannedAt: '2026-09-15T12:00:00.000Z', score: 4.4 },
      { scannedAt: '2026-09-20T12:00:00.000Z', score: 5.5 },
      { scannedAt: '2026-09-25T12:00:00.000Z', score: 6.6 },
      { scannedAt: '2026-09-30T12:00:00.000Z', score: 7.7 },
    ]);

    const points = [...container.querySelectorAll<HTMLElement>('[data-testid="asset-risk-trend-point"]')];
    expect(points).toHaveLength(5);
    expect(points.map((point) => point.querySelector('time')?.getAttribute('datetime'))).toEqual([
      '2026-09-30T12:00:00.000Z',
      '2026-09-25T12:00:00.000Z',
      '2026-09-20T12:00:00.000Z',
      '2026-09-15T12:00:00.000Z',
      '2026-09-10T12:00:00.000Z',
    ]);
    expect(points[0]?.textContent).toContain('Score 7.7');
    expect(points[4]?.textContent).toContain('Score 3.3');
    expect(container.textContent).not.toContain('Score 2.2');
  });

  it('preserves the empty history card and unavailable summary', async () => {
    await act(async () => {
      apiFetchMock.mockResolvedValue({ host: HOST, series: [] });
      root.render(<AssetRiskTrendSparkline host={HOST} />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="asset-risk-trend-empty"]')).not.toBeNull();
    expect(container.textContent).toContain(
      'No dated risk scores are available for this host in the last 30 days.',
    );
    expect(container.textContent).toContain('Unavailable — need at least two valid dated scores');
    expect(container.textContent).not.toContain('Baseline scan date');
    expect(container.textContent).not.toContain('Latest scan date');
  });

  it('shows an unavailable summary when only one dated score exists', async () => {
    const summary = await renderTrend([
      { scannedAt: '2026-09-15T12:00:00.000Z', score: 5.1 },
    ]);

    expect(summary.textContent).toContain('Unavailable — need at least two valid dated scores');
    expect(
      summary.querySelector('[data-testid="asset-risk-trend-summary-unavailable"]')?.tagName,
    ).toBe('OUTPUT');
    expect(summary.textContent).not.toContain('Baseline scan date');
    expect(summary.textContent).not.toContain('Latest scan date');
    expect(summary.textContent).not.toContain('Change');
    expect(summary.textContent).not.toContain('Risk increased');
    expect(summary.textContent).not.toContain('Risk decreased');
  });
});
