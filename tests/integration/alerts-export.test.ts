// @polsia:user-owned — Contract coverage for the workspace alerts adapter and
// the installed CSV export engine.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSV_EXPORT_LIMITS } from '../../src/modules/csv-export/contracts';
import {
  CsvAccessError,
  defineCsvSource,
  type CsvExportColumn,
} from '../../src/modules/csv-export/server';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const sourceText = readFileSync(resolve(root, 'src/lib/csv-export/sources.server.ts'), 'utf8');
const routeText = readFileSync(resolve(root, 'src/app/api/alerts/export.csv/route.ts'), 'utf8');
const moduleServerText = readFileSync(resolve(root, 'src/modules/csv-export/server.ts'), 'utf8');
const buttonText = readFileSync(
  resolve(root, 'src/components/dashboard/alerts-export-button.tsx'),
  'utf8',
);
const filterHelperText = readFileSync(
  resolve(root, 'src/lib/business/alerts-export-filters.ts'),
  'utf8',
);
const pageText = readFileSync(resolve(root, 'src/app/(dashboard)/alerts/page.tsx'), 'utf8');

interface FixtureRow {
  id: string;
  value: string;
}

interface FixtureFilters {
  count: number;
  value: string;
}

const fixtureColumn: CsvExportColumn<FixtureRow> = {
  key: 'value',
  label: 'Value',
  kind: 'text',
  access: 'readonly',
  nullable: false,
  serialize: (row) => row.value,
};

function fixtureSource() {
  return defineCsvSource<FixtureRow, FixtureFilters>({
    id: 'fixture-alerts',
    label: 'Fixture alerts',
    schemaVersion: '1',
    columns: [fixtureColumn],
    parseFilters(raw) {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !('count' in raw) ||
        !('value' in raw) ||
        typeof raw.count !== 'number' ||
        !Number.isSafeInteger(raw.count) ||
        raw.count < 0 ||
        typeof raw.value !== 'string'
      ) {
        return { ok: false };
      }
      return { ok: true, value: { count: raw.count, value: raw.value } };
    },
    async authorizeColumns() {
      return ['value'];
    },
    keyOf: (row) => row.id,
    versionOf: () => 'v1',
    async readRows({ filters }) {
      return Array.from({ length: filters.count }, (_, index) => ({
        id: `alert-${String(index).padStart(5, '0')}`,
        value: filters.value,
      }));
    },
  });
}

const context = { actorId: 'user-fixture', scopeId: 'workspace-fixture' };

describe('workspace alerts CSV adapter', () => {
  it('routes the existing alert export path through the installed CSV engine', () => {
    expect(routeText).toContain('createCsvExportHandlers');
    expect(routeText).toContain('export const POST = handlers.POST');
    expect(routeText).toContain('csvExportSources');
    expect(routeText).not.toContain('ReadableStream');
    expect(buttonText).toContain('endpoint="/api/alerts/export.csv"');
    expect(pageText).toContain('<AlertsExportButton search={effectiveQs}');
  });

  it('derives the export scope from the active workspace and requires its active roster row', () => {
    expect(sourceText).toContain('resolveDashboardWorkspaceContext(session.user.id)');
    expect(sourceText).toContain('workspaceContext?.workspaceMemberId');
    expect(sourceText).toContain('prisma.workspaceMember.findFirst');
    expect(sourceText).toContain('id: workspaceContext.workspaceMemberId');
    expect(sourceText).toContain('workspaceId: workspaceContext.workspaceId');
    expect(sourceText).toContain('userId: session.user.id');
    expect(sourceText).toContain('hasAtLeast(workspaceMember.role, \'member\')');
    expect(sourceText).toContain('return { actorId: session.user.id, scopeId: workspaceContext.workspaceId }');
    expect(sourceText).toContain('teamId: input.context.scopeId');
    expect(sourceText).toContain("status: 'active'");
    expect(sourceText).not.toContain('prisma.membership.findUnique');
    expect(sourceText).not.toMatch(/filters\.(?:teamId|workspaceId)/);
  });

  it('keeps the eight permitted alert fields fixed and validates the current list filters', () => {
    const alertsSource = sourceText.slice(0, sourceText.indexOf('interface AssetCsvRow'));
    const declaredKeys = [...alertsSource.matchAll(/key: '([a-z_]+)'/g)].map((match) => match[1]);
    expect(declaredKeys).toEqual([
      'finding_title',
      'asset_host',
      'severity',
      'status',
      'cve_id',
      'opened_at',
      'last_activity_at',
      'snoozed_until',
    ]);
    expect(sourceText).toContain('AlertQuery.pick({');
    expect(sourceText).toContain('}).strict()');
    expect(sourceText).toContain("ownedByMe: z.literal('1').optional()");
    expect(sourceText).toContain("remediated: z.literal('1').optional()");
    expect(sourceText).toContain("snoozed: z.literal('1').optional()");
    expect(sourceText).toContain('compareAlertRowsBySort(');
    expect(sourceText).toContain('priorityScore: true');
    expect(sourceText).toContain('priorityScore: a.priorityScore');
    expect(sourceText).toContain('priorityScore: b.priorityScore');

    const expectedFilterKeys = [
      'resolution',
      'severity',
      'source',
      'triggeredBy',
      'status',
      'acknowledged',
      'assigneeReady',
      'hideSnoozed',
      'highRiskAssets',
      'q',
      'hostname',
      'asset',
      'from',
      'to',
      'since',
      'sort',
      'ownedByMe',
      'remediated',
      'snoozed',
    ];
    const buttonFilterKeys = [...filterHelperText.matchAll(/'([A-Za-z]+)'/g)]
      .map((match) => match[1])
      .filter(
        (key): key is string => key !== undefined && expectedFilterKeys.includes(key),
      );
    expect(buttonFilterKeys).toEqual(expectedFilterKeys);
  });

  it('reads a single repeatable-read snapshot, bounded to the module limit plus one', () => {
    expect(sourceText).toContain('take: input.limit');
    expect(sourceText).toContain('limit, signal');
    expect(sourceText).toContain('Prisma.TransactionIsolationLevel.RepeatableRead');
    expect(sourceText).toContain("SET LOCAL statement_timeout = '25000ms'");
    expect(sourceText).toContain('timeout: CSV_EXPORT_LIMITS.readMilliseconds');
    expect(moduleServerText).toContain('CSV_EXPORT_LIMITS.records + 1');
  });

  it('emits exactly the eight allowed fields and denies caller-added fields', async () => {
    const source = fixtureSource();
    const description = await source.describe(context);
    expect(description.columns.map((column) => column.key)).toEqual(['value']);
    await expect(
      source.export({ filters: { count: 1, value: 'visible' }, columns: ['secret'] }, context),
    ).rejects.toBeInstanceOf(CsvAccessError);
  });

  it('allows exactly 10,000 records and rejects the 10,001st without truncation', async () => {
    const source = fixtureSource();
    const atLimit = await source.export(
      { filters: { count: CSV_EXPORT_LIMITS.records, value: 'alert' } },
      context,
    );
    expect(atLimit.records).toBe(10_000);

    await expect(
      source.export({ filters: { count: CSV_EXPORT_LIMITS.records + 1, value: 'alert' } }, context),
    ).rejects.toMatchObject({ code: 'ROW_LIMIT' });
  });

  it('measures UTF-8 output bytes and rejects multibyte output over 10 MiB', async () => {
    const source = fixtureSource();
    await expect(
      source.export({ filters: { count: 5_000, value: 'é'.repeat(1_200) } }, context),
    ).rejects.toMatchObject({ code: 'BYTE_LIMIT' });
    expect(CSV_EXPORT_LIMITS.bytes).toBe(10 * 1024 * 1024);
  });

  it('rejects malformed filters and reports an empty export as the module-defined no-results response', async () => {
    const source = fixtureSource();
    await expect(
      source.export({ filters: { count: -1, value: 'bad' } }, context),
    ).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    await expect(
      source.export({ filters: { count: 0, value: 'none' } }, context),
    ).rejects.toMatchObject({ code: 'NO_RESULTS' });
  });
});
