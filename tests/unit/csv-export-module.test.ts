// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  CSV_EXPORT_LIMITS,
  CsvExportError,
} from '@/modules/csv-export/contracts';
import {
  defineCsvSource,
  type CsvExportColumn,
} from '@/modules/csv-export/server';
import { decodeCell, encodeCell } from '@/modules/csv-export/serialization';

interface FixtureRow {
  id: string;
  host: string;
}

const hostColumn: CsvExportColumn<FixtureRow> = {
  key: 'host',
  label: 'Host',
  kind: 'text',
  access: 'readonly',
  nullable: false,
  serialize: (row) => row.host,
};

function makeSource(count: number, host = 'asset.example.test') {
  return defineCsvSource<FixtureRow, { count: number }>({
    id: 'test-assets',
    label: 'Test assets',
    schemaVersion: '1',
    columns: [hostColumn],
    parseFilters(raw) {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !('count' in raw) ||
        typeof raw.count !== 'number' ||
        !Number.isSafeInteger(raw.count) ||
        raw.count < 0
      ) {
        return { ok: false };
      }
      return { ok: true, value: { count: raw.count } };
    },
    async authorizeColumns() {
      return ['host'];
    },
    keyOf: (row) => row.id,
    versionOf: (row) => row.host,
    async readRows({ filters, limit }) {
      return Array.from({ length: Math.min(filters.count, limit) }, (_, index) => ({
        id: `asset-${String(index).padStart(5, '0')}`,
        host,
      }));
    },
  });
}

describe('CSV export module result limits', () => {
  const context = { actorId: 'member-test', scopeId: 'workspace-test' };

  it('retains the installed record, byte, cell, and read limits', () => {
    expect(CSV_EXPORT_LIMITS).toMatchObject({
      records: 10_000,
      bytes: 10_485_760,
      cellCharacters: 16_384,
      readMilliseconds: 30_000,
    });
    expect(decodeCell(encodeCell(null))).toBeNull();
  });

  it('returns the explicit no-results outcome without producing an empty CSV', async () => {
    await expect(makeSource(0).export({ filters: { count: 0 } }, context)).rejects.toMatchObject({
      code: 'NO_RESULTS',
    });
  });

  it('rejects the 10,001st record instead of truncating the export', async () => {
    await expect(
      makeSource(CSV_EXPORT_LIMITS.records + 1).export(
        { filters: { count: CSV_EXPORT_LIMITS.records + 1 } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'ROW_LIMIT' });
  });

  it('allows an export at the 10,000-record cap', async () => {
    const result = await makeSource(CSV_EXPORT_LIMITS.records).export(
      { filters: { count: CSV_EXPORT_LIMITS.records } },
      context,
    );
    expect(result.records).toBe(10_000);
  });

  it('rejects a CSV larger than 10 MiB instead of returning a partial file', async () => {
    const source = makeSource(700, 'x'.repeat(16_000));
    await expect(source.export({ filters: { count: 700 } }, context)).rejects.toBeInstanceOf(
      CsvExportError,
    );
    await expect(source.export({ filters: { count: 700 } }, context)).rejects.toMatchObject({
      code: 'BYTE_LIMIT',
    });
  });

  it('rejects a cell above the existing 16,384-character cap', async () => {
    await expect(
      makeSource(1, 'x'.repeat(CSV_EXPORT_LIMITS.cellCharacters)).export(
        { filters: { count: 1 } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CELL_LIMIT' });
  });
});
