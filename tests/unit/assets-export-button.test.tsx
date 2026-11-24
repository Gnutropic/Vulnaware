// @vitest-environment jsdom

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn() }));

import { AssetsExportButton } from '@/components/dashboard/assets-export-button';
import { apiFetch } from '@/lib/api-client';
import { CSV_EXPORT_ERRORS } from '@/modules/csv-export/contracts';
import * as csvDownload from '@/modules/csv-export/download';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderButton() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AssetsExportButton
        q="service.example.test"
        severity="high"
        status="resolved"
        minRiskScore={6.5}
        scanRecency="last30d"
        riskTrend="rising"
        alertPresence="without"
        sort="latestScanAt:asc"
      />,
    );
  });
  return container;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.spyOn(csvDownload, 'saveCsvFile').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('assets CSV export control', () => {
  it('sends every active filter and does not apply table pagination', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: { csv: 'csv-data', filename: 'vulnaware-assets.csv', records: 2 },
    });
    const host = await renderButton();
    const button = host.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('expected export button');

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    const [path, options] = vi.mocked(apiFetch).mock.calls[0] ?? [];
    expect(path).toBe('/api/assets/export.csv');
    expect(JSON.parse(String(options?.body))).toEqual({
      sourceId: 'vulnaware-assets',
      delimiter: ',',
      filters: {
        sort: 'latestScanAt:asc',
        q: 'service.example.test',
        severity: 'high',
        status: 'resolved',
        minRiskScore: '6.5',
        scanRecency: 'last30d',
        riskTrend: 'rising',
        alertPresence: 'without',
      },
    });
    expect(String(options?.body)).not.toMatch(/pageSize|page/);
    expect(csvDownload.saveCsvFile).toHaveBeenCalledWith('csv-data', 'vulnaware-assets.csv');
  });

  it('shows the module no-results error and creates no empty download', async () => {
    const noResults = Object.assign(new Error('export failed'), {
      cause: {
        ok: false,
        error: { code: 'NO_RESULTS', message: 'No results' },
      },
    });
    vi.mocked(apiFetch).mockRejectedValue(noResults);
    const host = await renderButton();
    const button = host.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('expected export button');

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Aucun résultat à exporter avec ces filtres.',
    );
    expect(csvDownload.saveCsvFile).not.toHaveBeenCalled();
  });

  it.each(['ROW_LIMIT', 'BYTE_LIMIT'] as const)(
    'shows the module %s error and creates no partial download',
    async (code) => {
      const message = CSV_EXPORT_ERRORS[code].message;
      vi.mocked(apiFetch).mockRejectedValue(
        Object.assign(new Error('export failed'), {
          cause: { ok: false, error: { code, message } },
        }),
      );
      const host = await renderButton();
      const button = host.querySelector<HTMLButtonElement>('button');
      if (!button) throw new Error('expected export button');

      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
      expect(csvDownload.saveCsvFile).not.toHaveBeenCalled();
    },
  );
});
