// @polsia:user-owned

import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { parseAssetNamesToOrList } from '@/lib/business/alerts-asset';
import { buildAlertsWhere } from '@/lib/business/alerts-query-where';
import { compareAlertRowsBySort } from '@/lib/business/alerts-sort';
import { matchesAssetAlertPresence } from '@/lib/business/assets-alert-presence';
import {
  type LatestAssetScan,
  matchesLatestAssetScanStatus,
  recordLatestWorkspaceAssetScan,
  serializeLatestAssetScan,
} from '@/lib/business/assets-latest-scan';
import {
  type AssetRiskFinding,
  groupAssetRiskFindings,
  matchesAssetRiskTrend,
} from '@/lib/business/assets-risk-trend';
import { calculateRiskScoreChange } from '@/lib/business/assets-risk-trend-summary';
import { matchesAssetScanRecency } from '@/lib/business/assets-scan-recency';
import { CSV_SUPPORT_READ_BATCH_SIZE, forEachIdPage } from '@/lib/business/csv-export-pagination';
import { resolveDashboardWorkspaceContext } from '@/lib/business/dashboard-workspace-context';
import { isAlertDateRangeOrdered } from '@/lib/contracts/alert-date-range';
import { AlertQuery } from '@/lib/contracts/alerts';
import { AssetQuery } from '@/lib/contracts/assets';
import { AssetDetailPathParam } from '@/lib/contracts/assets-detail';
import { prisma } from '@/lib/db';
import { hasAtLeast } from '@/lib/permissions/roles';
import { CSV_EXPORT_LIMITS } from '@/modules/csv-export/contracts';
import {
  CsvAccessError,
  type CsvExportColumn,
  defineCsvSource,
  type ExportContext,
} from '@/modules/csv-export/server';

const AlertFilterShape = AlertQuery.pick({
  resolution: true,
  severity: true,
  source: true,
  triggeredBy: true,
  status: true,
  acknowledged: true,
  assigneeReady: true,
  hideSnoozed: true,
  highRiskAssets: true,
  q: true,
  hostname: true,
  asset: true,
  from: true,
  to: true,
  since: true,
  sort: true,
});

const AlertsExportFiltersSchema = AlertFilterShape.extend({
  ownedByMe: z.literal('1').optional(),
  remediated: z.literal('1').optional(),
  snoozed: z.literal('1').optional(),
})
  .strict()
  .superRefine((filters, context) => {
    if (!isAlertDateRangeOrdered(filters.from, filters.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'to must be on or after from.',
      });
    }
  });

type AlertsExportFilters = z.infer<typeof AlertsExportFiltersSchema>;

const AssetsExportFiltersSchema = AssetQuery.pick({
  severity: true,
  status: true,
  q: true,
  minRiskScore: true,
  scanRecency: true,
  latestScanStatus: true,
  neverScanned: true,
  riskTrend: true,
  alertPresence: true,
  sort: true,
}).strict();

type AssetsExportFilters = z.infer<typeof AssetsExportFiltersSchema>;

const AssetRiskHistoryFiltersSchema = z.object({ host: z.string().min(1) }).strict();
type AssetRiskHistoryFilters = z.infer<typeof AssetRiskHistoryFiltersSchema>;

interface AlertCsvRow {
  id: string;
  exportOrder: number;
  findingTitle: string | null;
  assetHost: string | null;
  severity: string | null;
  status: string;
  cveId: string | null;
  openedAt: Date;
  lastActivityAt: Date | null;
  snoozedUntil: Date | null;
  priorityScore: number | null;
}

const alertColumns: readonly CsvExportColumn<AlertCsvRow>[] = [
  {
    key: 'finding_title',
    label: 'Finding title',
    kind: 'text',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.findingTitle,
  },
  {
    key: 'asset_host',
    label: 'Asset host',
    kind: 'text',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.assetHost,
  },
  {
    key: 'severity',
    label: 'Severity',
    kind: 'text',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.severity,
  },
  {
    key: 'status',
    label: 'Status',
    kind: 'identifier',
    access: 'readonly',
    nullable: false,
    serialize: (row) => row.status,
  },
  {
    key: 'cve_id',
    label: 'CVE ID',
    kind: 'identifier',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.cveId,
  },
  {
    key: 'opened_at',
    label: 'Opened at',
    kind: 'datetime',
    access: 'readonly',
    nullable: false,
    serialize: (row) => row.openedAt.toISOString(),
  },
  {
    key: 'last_activity_at',
    label: 'Last activity at',
    kind: 'datetime',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.lastActivityAt?.toISOString() ?? null,
  },
  {
    key: 'snoozed_until',
    label: 'Snoozed until',
    kind: 'datetime',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.snoozedUntil?.toISOString() ?? null,
  },
];

interface AssetCsvRow {
  exportOrder: number;
  host: string;
  openAlertCount: number;
  lastScanAt: string | null;
  latestScanStatus: string | null;
  riskScore: number | null;
  lastActivityAt: Date | null;
}

interface AssetRollupAccumulator {
  host: string;
  openAlertCount: number;
  unresolvedAlertCount: number;
  criticalCount: number;
  lastScanAt: Date | null;
  latestScanAt: string | null;
  latestScanStatus: string | null;
  riskScore: number | null;
  lastActivityAt: Date | null;
}

const assetColumns: readonly CsvExportColumn<AssetCsvRow>[] = [
  {
    key: 'host',
    label: 'Host',
    kind: 'text',
    access: 'readonly',
    nullable: false,
    serialize: (row) => row.host,
  },
  {
    key: 'open_alert_count',
    label: 'Open alert count',
    kind: 'number',
    access: 'readonly',
    nullable: false,
    serialize: (row) => String(row.openAlertCount),
  },
  {
    key: 'last_scan_at',
    label: 'Last scan at',
    kind: 'datetime',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.lastScanAt,
  },
  {
    key: 'latest_scan_status',
    label: 'Latest scan status',
    kind: 'identifier',
    access: 'readonly',
    nullable: true,
    serialize: (row) => row.latestScanStatus,
  },
  {
    key: 'risk_score',
    label: 'Risk score',
    kind: 'number',
    access: 'readonly',
    nullable: true,
    serialize: (row) => (row.riskScore === null ? null : String(row.riskScore)),
  },
];

interface AssetRiskHistoryCsvRow {
  exportOrder: number;
  scanId: string;
  scannedAt: Date;
  score: number;
}

const assetRiskHistoryColumns: readonly CsvExportColumn<AssetRiskHistoryCsvRow>[] = [
  {
    key: 'scanned_at',
    label: 'Scanned at',
    kind: 'datetime',
    access: 'readonly',
    nullable: false,
    serialize: (row) => row.scannedAt.toISOString(),
  },
  {
    key: 'risk_score',
    label: 'Risk score',
    kind: 'number',
    access: 'readonly',
    nullable: false,
    serialize: (row) => String(row.score),
  },
];

function isCriticalSeverity(value: string | null): boolean {
  return value?.toLowerCase() === 'critical';
}

function parseFilters(raw: unknown) {
  const parsed = AlertsExportFiltersSchema.safeParse(raw);
  if (!parsed.success) return { ok: false } as const;
  try {
    parseAssetNamesToOrList(parsed.data.asset ?? null);
  } catch {
    return { ok: false } as const;
  }
  return { ok: true, value: parsed.data } as const;
}

function rowVersion(row: AlertCsvRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.findingTitle,
        row.assetHost,
        row.severity,
        row.status,
        row.cveId,
        row.openedAt.toISOString(),
        row.lastActivityAt?.toISOString() ?? null,
        row.snoozedUntil?.toISOString() ?? null,
        row.priorityScore,
      ]),
    )
    .digest('hex');
}

function assetRowVersion(row: AssetCsvRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.host,
        row.openAlertCount,
        row.lastScanAt,
        row.latestScanStatus,
        row.riskScore,
      ]),
    )
    .digest('hex');
}

async function searchFindingClause(
  tx: Prisma.TransactionClient,
  query: string | undefined,
  hostname?: string,
): Promise<Prisma.VulnerabilityFindingWhereInput | undefined> {
  const hostnameQuery = hostname?.trim() || undefined;
  const hostnameClause = hostnameQuery
    ? { host: { contains: hostnameQuery, mode: 'insensitive' as const } }
    : undefined;
  if (!query) return hostnameClause ? { asset: hostnameClause } : undefined;

  const matchingCves = await tx.cveEntry.findMany({
    where: { description: { contains: query, mode: 'insensitive' } },
    select: { cveId: true },
  });
  const cveIds = Array.from(new Set(matchingCves.map((entry) => entry.cveId)));
  const OR: Prisma.VulnerabilityFindingWhereInput[] = [
    { cveId: { contains: query, mode: 'insensitive' } },
    { asset: { host: { contains: query, mode: 'insensitive' } } },
  ];
  if (cveIds.length > 0) OR.push({ cveId: { in: cveIds } });
  return {
    OR,
    ...(hostnameClause ? { asset: hostnameClause } : {}),
  };
}

async function readScopedAlerts(input: {
  context: ExportContext;
  filters: AlertsExportFilters;
  limit: number;
  signal: AbortSignal;
}): Promise<AlertCsvRow[]> {
  return prisma.$transaction(
    async (tx) => {
      if (input.signal.aborted) throw new Error('CSV export cancelled');
      await tx.$executeRaw`SET LOCAL statement_timeout = '25000ms'`;

      const workspaceMember = await tx.workspaceMember.findFirst({
        where: {
          workspaceId: input.context.scopeId,
          userId: input.context.actorId,
          status: 'active',
        },
        select: { id: true },
      });
      if (!workspaceMember) throw new Error('Active workspace membership required');

      const filters = input.filters;
      const now = new Date();
      const searchFinding = await searchFindingClause(tx, filters.q, filters.hostname);
      const { where } = buildAlertsWhere({
        teamId: input.context.scopeId,
        workspaceMemberId: workspaceMember.id,
        filters,
        searchFinding,
        assetOrList: parseAssetNamesToOrList(filters.asset ?? null),
        now,
      });

      const rows = await tx.alert.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          severity: true,
          status: true,
          createdAt: true,
          remediatedAt: true,
          snoozedUntil: true,
          finding: {
            select: {
              cveId: true,
              priorityScore: true,
              asset: { select: { host: true } },
            },
          },
        },
      });
      if (input.signal.aborted) throw new Error('CSV export cancelled');

      const alertIds = rows.map((row) => row.id);
      const cveIds = Array.from(new Set(rows.map((row) => row.finding?.cveId).filter(Boolean)));
      const [noteGroups, cveEntries] = await Promise.all([
        alertIds.length > 0
          ? tx.alertNote.groupBy({
              by: ['alertId'],
              where: { alertId: { in: alertIds }, alert: { teamId: input.context.scopeId } },
              _max: { createdAt: true },
            })
          : Promise.resolve([]),
        cveIds.length > 0
          ? tx.cveEntry.findMany({
              where: { cveId: { in: cveIds } },
              select: { cveId: true, description: true },
            })
          : Promise.resolve([]),
      ]);
      if (input.signal.aborted) throw new Error('CSV export cancelled');

      const noteDates = new Map(
        noteGroups.flatMap((group) =>
          group._max.createdAt ? [[group.alertId, group._max.createdAt] as const] : [],
        ),
      );
      const titles = new Map(cveEntries.map((entry) => [entry.cveId, entry.description]));
      const ranked = rows
        .map((row) => {
          const noteDate = noteDates.get(row.id) ?? null;
          const lastActivityAt =
            noteDate && row.remediatedAt
              ? noteDate.getTime() > row.remediatedAt.getTime()
                ? noteDate
                : row.remediatedAt
              : (noteDate ?? row.remediatedAt ?? null);
          return {
            id: row.id,
            findingTitle: row.finding ? (titles.get(row.finding.cveId) ?? null) : null,
            assetHost: row.finding?.asset?.host ?? null,
            severity: row.severity,
            status: row.status,
            cveId: row.finding?.cveId ?? null,
            openedAt: row.createdAt,
            lastActivityAt,
            snoozedUntil: row.snoozedUntil,
            priorityScore: row.finding?.priorityScore ?? null,
          };
        })
        .sort((a, b) =>
          compareAlertRowsBySort(
            {
              id: a.id,
              severity: a.severity,
              hostname: a.assetHost,
              status: a.status,
              createdAt: a.openedAt,
              lastActivityAt: a.lastActivityAt,
              priorityScore: a.priorityScore,
            },
            {
              id: b.id,
              severity: b.severity,
              hostname: b.assetHost,
              status: b.status,
              createdAt: b.openedAt,
              lastActivityAt: b.lastActivityAt,
              priorityScore: b.priorityScore,
            },
            filters.sort,
          ),
        );

      return ranked.map((row, exportOrder) => ({ ...row, exportOrder }));
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: CSV_EXPORT_LIMITS.readMilliseconds,
    },
  );
}

async function readScopedAssets(input: {
  context: ExportContext;
  filters: AssetsExportFilters;
  limit: number;
  signal: AbortSignal;
}): Promise<AssetCsvRow[]> {
  return prisma.$transaction(
    async (tx) => {
      if (input.signal.aborted) throw new Error('CSV export cancelled');
      await tx.$executeRaw`SET LOCAL statement_timeout = '25000ms'`;

      const workspaceMember = await tx.workspaceMember.findFirst({
        where: {
          workspaceId: input.context.scopeId,
          userId: input.context.actorId,
          status: 'active',
        },
        select: { role: true },
      });
      if (!workspaceMember || !hasAtLeast(workspaceMember.role, 'member')) {
        throw new Error('Active member workspace access required');
      }

      const hostnameQuery = input.filters.q?.trim() || undefined;
      const now = new Date();
      const scopeId = input.context.scopeId;
      const output: AssetRollupAccumulator[] = [];
      const riskScoreChangesByHost = new Map<string, number | null>();
      const rollupByHost = new Map<string, AssetRollupAccumulator>();
      const unresolvedCountByHost = new Map<string, number>();

      // Page workspace alerts by their indexed scalar scope first, then read
      // only the referenced findings whose assets belong to the same workspace.
      // Keeping hostname matching in memory avoids a costly nested alert/finding/
      // asset/scan predicate on large histories while preserving both scope
      // boundaries and every contributing alert.
      await forEachIdPage({
        signal: input.signal,
        fetchPage: (afterId) =>
          tx.alert.findMany({
            where: {
              teamId: scopeId,
              findingId: { not: 'manual' },
              ...(afterId ? { id: { gt: afterId } } : {}),
            },
            orderBy: { id: 'asc' },
            take: CSV_SUPPORT_READ_BATCH_SIZE,
            select: {
              id: true,
              findingId: true,
              severity: true,
              status: true,
              remediatedAt: true,
            },
          }),
        consume: async (rows) => {
          const findings = await tx.vulnerabilityFinding.findMany({
            where: {
              id: { in: rows.map((row) => row.findingId) },
              asset: { scan: { teamId: scopeId } },
            },
            select: {
              id: true,
              priorityScore: true,
              asset: { select: { host: true } },
            },
          });
          const findingById = new Map(findings.map((finding) => [finding.id, finding]));
          const matchedRows = rows.filter((row) => {
            const finding = findingById.get(row.findingId);
            return (
              finding !== undefined &&
              (!hostnameQuery ||
                finding.asset.host.toLowerCase().includes(hostnameQuery.toLowerCase())) &&
              (!input.filters.severity || row.severity === input.filters.severity) &&
              (!input.filters.status || row.status === input.filters.status)
            );
          });
          const noteGroups =
            matchedRows.length > 0
              ? await tx.alertNote.groupBy({
                  by: ['alertId'],
                  where: {
                    alertId: { in: matchedRows.map((row) => row.id) },
                    alert: { teamId: scopeId },
                  },
                  _max: { createdAt: true },
                })
              : [];
          if (input.signal.aborted) throw new Error('CSV export cancelled');

          const noteMaxByAlertId = new Map(
            noteGroups.flatMap((group) =>
              group._max.createdAt ? [[group.alertId, group._max.createdAt] as const] : [],
            ),
          );
          const matchedAlertIds = new Set(matchedRows.map((row) => row.id));
          for (const row of rows) {
            const finding = findingById.get(row.findingId);
            if (!finding) continue;
            const host = finding.asset.host;
            if (hostnameQuery && !host.toLowerCase().includes(hostnameQuery.toLowerCase())) {
              continue;
            }
            if (row.status === 'open' || row.status === 'in_progress') {
              unresolvedCountByHost.set(host, (unresolvedCountByHost.get(host) ?? 0) + 1);
            }
            if (!matchedAlertIds.has(row.id)) continue;

            const noteDate = noteMaxByAlertId.get(row.id) ?? null;
            const lastActivityAt =
              noteDate && row.remediatedAt
                ? noteDate.getTime() > row.remediatedAt.getTime()
                  ? noteDate
                  : row.remediatedAt
                : (noteDate ?? row.remediatedAt ?? null);
            const existing = rollupByHost.get(host);
            if (!existing) {
              rollupByHost.set(host, {
                host,
                openAlertCount: row.status === 'open' ? 1 : 0,
                unresolvedAlertCount: 0,
                criticalCount: isCriticalSeverity(row.severity) ? 1 : 0,
                lastScanAt: null,
                latestScanAt: null,
                latestScanStatus: null,
                riskScore: finding.priorityScore,
                lastActivityAt,
              });
              continue;
            }
            if (row.status === 'open') existing.openAlertCount += 1;
            if (isCriticalSeverity(row.severity)) existing.criticalCount += 1;
            if (
              finding.priorityScore !== null &&
              (existing.riskScore === null || finding.priorityScore > existing.riskScore)
            ) {
              existing.riskScore = finding.priorityScore;
            }
            if (
              lastActivityAt &&
              (!existing.lastActivityAt || lastActivityAt > existing.lastActivityAt)
            ) {
              existing.lastActivityAt = lastActivityAt;
            }
          }
        },
      });
      for (const [host, row] of rollupByHost) {
        row.unresolvedAlertCount = unresolvedCountByHost.get(host) ?? 0;
      }

      const orderedHosts = [...rollupByHost.keys()].sort((a, b) => a.localeCompare(b));
      const hostBatchSize = CSV_SUPPORT_READ_BATCH_SIZE;
      let hostOffset = 0;

      while (true) {
        if (input.signal.aborted) throw new Error('CSV export cancelled');
        const hosts = orderedHosts.slice(hostOffset, hostOffset + hostBatchSize);
        if (hosts.length === 0) break;
        hostOffset += hosts.length;

        const hostRollups = hosts.flatMap((host) => {
          const row = rollupByHost.get(host);
          return row ? [row] : [];
        });
        const rollupHosts = hostRollups.map((row) => row.host);
        const latestScanByHost = new Map<string, LatestAssetScan>();
        const completedScanHosts = new Set<string>();
        const scanIds30dByHost = new Map<string, Set<string>>();
        const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        await forEachIdPage({
          signal: input.signal,
          fetchPage: (afterId) =>
            tx.asset.findMany({
              where: {
                host: { in: rollupHosts },
                scan: { teamId: scopeId },
                ...(afterId ? { id: { gt: afterId } } : {}),
              },
              orderBy: { id: 'asc' },
              take: CSV_SUPPORT_READ_BATCH_SIZE,
              select: {
                id: true,
                host: true,
                scan: { select: { id: true, teamId: true, startedAt: true, status: true } },
              },
            }),
          consume: async (scanRows) => {
            for (const scanRow of scanRows) {
              if (!recordLatestWorkspaceAssetScan(latestScanByHost, scanRow, scopeId)) continue;
              if (scanRow.scan.status === 'completed') completedScanHosts.add(scanRow.host);

              const startedAt = scanRow.scan.startedAt.getTime();
              if (startedAt >= cutoff30d.getTime() && startedAt <= now.getTime()) {
                const scanIds = scanIds30dByHost.get(scanRow.host) ?? new Set<string>();
                scanIds.add(scanRow.scan.id);
                scanIds30dByHost.set(scanRow.host, scanIds);
              }
            }
          },
        });

        const thresholdedRollups = hostRollups
          .map((row) => {
            const latestScan = latestScanByHost.get(row.host);
            return {
              ...row,
              lastScanAt: latestScan?.startedAt ?? null,
              ...serializeLatestAssetScan(latestScan),
            };
          })
          .filter(
            (row) =>
              matchesAssetScanRecency(
                row.lastScanAt,
                input.filters.scanRecency,
                now,
                scanIds30dByHost.get(row.host)?.size ?? 0,
              ) &&
              matchesLatestAssetScanStatus(
                latestScanByHost.get(row.host),
                input.filters.latestScanStatus,
              ) &&
              (!input.filters.neverScanned || !completedScanHosts.has(row.host)) &&
              (input.filters.minRiskScore === undefined ||
                (row.riskScore !== null && row.riskScore >= input.filters.minRiskScore)),
          )
          .filter((row) =>
            matchesAssetAlertPresence(
              unresolvedCountByHost.get(row.host) ?? 0,
              input.filters.alertPresence,
            ),
          );

        const needsRiskScoreChanges =
          input.filters.riskTrend !== undefined ||
          input.filters.sort === 'riskScoreChange' ||
          input.filters.sort === 'riskScoreChange:asc';
        const riskScoreChanges = new Map<string, number | null>(
          thresholdedRollups.map((row) => [row.host, null]),
        );
        if (needsRiskScoreChanges && thresholdedRollups.length > 0) {
          const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          const findingsByHost = new Map<string, AssetRiskFinding[]>();
          await forEachIdPage({
            signal: input.signal,
            fetchPage: (afterId) =>
              tx.vulnerabilityFinding.findMany({
                where: {
                  priorityScore: { not: null },
                  asset: { host: { in: thresholdedRollups.map((row) => row.host) } },
                  scan: { teamId: scopeId, startedAt: { gte: from, lte: now } },
                  ...(afterId ? { id: { gt: afterId } } : {}),
                },
                orderBy: { id: 'asc' },
                take: CSV_SUPPORT_READ_BATCH_SIZE,
                select: {
                  id: true,
                  asset: { select: { host: true } },
                  scanId: true,
                  priorityScore: true,
                  scan: { select: { startedAt: true } },
                },
              }),
            consume: async (rows) => {
              for (const finding of rows) {
                const hostFindings = findingsByHost.get(finding.asset.host) ?? [];
                hostFindings.push(finding);
                findingsByHost.set(finding.asset.host, hostFindings);
              }
            },
          });
          for (const [host, findings] of findingsByHost) {
            const points = groupAssetRiskFindings(findings).map(({ scannedAt, score }) => ({
              scannedAt: scannedAt.toISOString(),
              score,
            }));
            riskScoreChanges.set(host, calculateRiskScoreChange(points)?.delta ?? null);
          }
        }
        for (const [host, change] of riskScoreChanges) {
          riskScoreChangesByHost.set(host, change);
        }

        const rollupsForExport = thresholdedRollups.filter((row) =>
          matchesAssetRiskTrend(riskScoreChanges.get(row.host) ?? null, input.filters.riskTrend),
        );
        output.push(...rollupsForExport);
        if (output.length >= input.limit) {
          // The CSV module checks the 10,001st row before serialization and
          // returns its explicit ROW_LIMIT response without making a file.
          return output.slice(0, input.limit).map((row, exportOrder) => ({
            exportOrder,
            host: row.host,
            openAlertCount: row.openAlertCount,
            lastScanAt: row.latestScanAt,
            latestScanStatus: row.latestScanStatus,
            riskScore: row.riskScore,
            lastActivityAt: row.lastActivityAt,
          }));
        }
      }

      const nameCmp = (a: string, b: string) => a.localeCompare(b);
      const nullsLastByTimestamp = (a: Date | null, b: Date | null) => {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return b.getTime() - a.getTime();
      };
      const compareScanTimestamp = (a: Date | null, b: Date | null, ascending: boolean) => {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return ascending ? a.getTime() - b.getTime() : b.getTime() - a.getTime();
      };

      const compare = (a: AssetRollupAccumulator, b: AssetRollupAccumulator): number => {
        switch (input.filters.sort) {
          case 'critical':
            if (a.criticalCount !== b.criticalCount) return b.criticalCount - a.criticalCount;
            return a.openAlertCount !== b.openAlertCount
              ? b.openAlertCount - a.openAlertCount
              : nameCmp(a.host, b.host);
          case 'lastActivity':
            return (
              nullsLastByTimestamp(a.lastActivityAt, b.lastActivityAt) || nameCmp(a.host, b.host)
            );
          case 'latestScanAt':
          case 'latestScanAt:asc':
            return (
              compareScanTimestamp(
                a.lastScanAt,
                b.lastScanAt,
                input.filters.sort === 'latestScanAt:asc',
              ) || nameCmp(a.host, b.host)
            );
          case 'name':
            return nameCmp(a.host, b.host);
          case 'riskScore':
            if (a.riskScore === null && b.riskScore === null) return nameCmp(a.host, b.host);
            if (a.riskScore === null) return 1;
            if (b.riskScore === null) return -1;
            return a.riskScore !== b.riskScore
              ? b.riskScore - a.riskScore
              : nameCmp(a.host, b.host);
          case 'riskScore:asc':
            if (a.riskScore === null && b.riskScore === null) return nameCmp(a.host, b.host);
            if (a.riskScore === null) return 1;
            if (b.riskScore === null) return -1;
            return a.riskScore !== b.riskScore
              ? a.riskScore - b.riskScore
              : nameCmp(a.host, b.host);
          case 'riskScoreChange':
          case 'riskScoreChange:asc': {
            const aChange = riskScoreChangesByHost.get(a.host) ?? null;
            const bChange = riskScoreChangesByHost.get(b.host) ?? null;
            if (aChange === null && bChange === null) return nameCmp(a.host, b.host);
            if (aChange === null) return 1;
            if (bChange === null) return -1;
            if (aChange !== bChange) {
              return input.filters.sort === 'riskScoreChange'
                ? bChange - aChange
                : aChange - bChange;
            }
            return nameCmp(a.host, b.host);
          }
          case 'openCount:asc':
            return a.openAlertCount !== b.openAlertCount
              ? a.openAlertCount - b.openAlertCount
              : nameCmp(a.host, b.host);
          case 'unresolvedCount':
            return a.unresolvedAlertCount !== b.unresolvedAlertCount
              ? b.unresolvedAlertCount - a.unresolvedAlertCount
              : nameCmp(a.host, b.host);
          case 'unresolvedCount:asc':
            return a.unresolvedAlertCount !== b.unresolvedAlertCount
              ? a.unresolvedAlertCount - b.unresolvedAlertCount
              : nameCmp(a.host, b.host);
          default:
            return a.openAlertCount !== b.openAlertCount
              ? b.openAlertCount - a.openAlertCount
              : nameCmp(a.host, b.host);
        }
      };

      return output
        .sort((a, b) => nameCmp(a.host, b.host))
        .sort(compare)
        .map(
          (
            { host, openAlertCount, latestScanAt, latestScanStatus, riskScore, lastActivityAt },
            exportOrder,
          ) => ({
            exportOrder,
            host,
            openAlertCount,
            lastScanAt: latestScanAt,
            latestScanStatus,
            riskScore,
            lastActivityAt,
          }),
        );
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: CSV_EXPORT_LIMITS.readMilliseconds,
    },
  );
}

function parseAssetFilters(raw: unknown) {
  // The active workspace comes from the authenticated export context. Ignore
  // a client workspaceId if present, while keeping every other filter strict.
  const filters =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'workspaceId'))
      : raw;
  const parsed = AssetsExportFiltersSchema.safeParse(filters);
  return parsed.success ? ({ ok: true, value: parsed.data } as const) : ({ ok: false } as const);
}

function parseAssetRiskHistoryFilters(raw: unknown) {
  const parsed = AssetRiskHistoryFiltersSchema.safeParse(raw);
  if (!parsed.success) return { ok: false } as const;

  let decodedHost: string;
  try {
    decodedHost = decodeURIComponent(parsed.data.host).toLowerCase().trim();
  } catch {
    return { ok: false } as const;
  }
  const validated = AssetDetailPathParam.safeParse({ host: decodedHost });
  return validated.success
    ? ({ ok: true, value: validated.data } as const)
    : ({ ok: false } as const);
}

function assetRiskHistoryRowVersion(row: AssetRiskHistoryCsvRow): string {
  return `${row.scannedAt.toISOString()}:${row.score}`;
}

async function readScopedAssetRiskHistory(input: {
  context: ExportContext;
  filters: AssetRiskHistoryFilters;
  limit: number;
  signal: AbortSignal;
}): Promise<AssetRiskHistoryCsvRow[]> {
  return prisma.$transaction(
    async (tx) => {
      if (input.signal.aborted) throw new Error('CSV export cancelled');
      await tx.$executeRaw`SET LOCAL statement_timeout = '25000ms'`;

      const workspaceMember = await tx.workspaceMember.findFirst({
        where: {
          workspaceId: input.context.scopeId,
          userId: input.context.actorId,
          status: 'active',
        },
        select: { id: true },
      });
      if (!workspaceMember) throw new Error('Active workspace membership required');

      const now = new Date();
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const candidateScans = await tx.scan.findMany({
        where: {
          teamId: input.context.scopeId,
          startedAt: { gte: from, lte: now },
          assets: {
            some: {
              host: input.filters.host,
              findings: { some: { priorityScore: { not: null } } },
            },
          },
        },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        take: input.limit,
        select: { id: true, startedAt: true },
      });
      if (input.signal.aborted) throw new Error('CSV export cancelled');

      const scanIds = candidateScans.map((scan) => scan.id);
      if (scanIds.length === 0) return [];

      const findings = await tx.vulnerabilityFinding.findMany({
        where: {
          scanId: { in: scanIds },
          priorityScore: { not: null },
          asset: { host: input.filters.host },
        },
        select: {
          scanId: true,
          priorityScore: true,
          scan: { select: { startedAt: true } },
        },
        orderBy: [{ scan: { startedAt: 'asc' } }, { scanId: 'asc' }],
      });
      if (input.signal.aborted) throw new Error('CSV export cancelled');

      return groupAssetRiskFindings(findings as AssetRiskFinding[]).map(
        ({ scanId, scannedAt, score }, exportOrder) => ({
          exportOrder,
          scanId,
          scannedAt,
          score,
        }),
      );
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: CSV_EXPORT_LIMITS.readMilliseconds,
    },
  );
}

export const csvExportSources = [
  defineCsvSource<AlertCsvRow, AlertsExportFilters>({
    id: 'vulnaware-alerts',
    label: 'Workspace alerts',
    schemaVersion: '1',
    columns: alertColumns,
    parseFilters,
    async authorizeColumns() {
      return alertColumns.map((column) => column.key);
    },
    keyOf(row) {
      // The module serializes records by stable key; the order prefix preserves
      // the same complete-result sort used by /alerts while the ID keeps keys unique.
      return `${String(row.exportOrder).padStart(5, '0')}:${row.id}`;
    },
    versionOf: rowVersion,
    readRows: ({ context, filters, limit, signal }) =>
      readScopedAlerts({ context, filters, limit, signal }),
  }),
  defineCsvSource<AssetCsvRow, AssetsExportFilters>({
    id: 'vulnaware-assets',
    label: 'Workspace assets',
    schemaVersion: '2',
    columns: assetColumns,
    parseFilters: parseAssetFilters,
    async authorizeColumns() {
      return assetColumns.map((column) => column.key);
    },
    keyOf(row) {
      return `${String(row.exportOrder).padStart(5, '0')}:${row.host}`;
    },
    versionOf: assetRowVersion,
    readRows: ({ context, filters, limit, signal }) =>
      readScopedAssets({ context, filters, limit, signal }),
  }),
  defineCsvSource<AssetRiskHistoryCsvRow, AssetRiskHistoryFilters>({
    id: 'vulnaware-asset-risk-history',
    label: 'Asset risk history',
    schemaVersion: '1',
    columns: assetRiskHistoryColumns,
    parseFilters: parseAssetRiskHistoryFilters,
    async authorizeColumns() {
      return assetRiskHistoryColumns.map((column) => column.key);
    },
    keyOf(row) {
      return `${String(row.exportOrder).padStart(5, '0')}:${row.scanId}`;
    },
    versionOf: assetRiskHistoryRowVersion,
    readRows: ({ context, filters, limit, signal }) =>
      readScopedAssetRiskHistory({ context, filters, limit, signal }),
  }),
];

export async function authorizeCsvExport(
  request: Request,
  sourceId: string,
): Promise<ExportContext> {
  if (
    sourceId !== 'vulnaware-alerts' &&
    sourceId !== 'vulnaware-assets' &&
    sourceId !== 'vulnaware-asset-risk-history'
  ) {
    throw new CsvAccessError(403);
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new CsvAccessError(401);

  const workspaceContext = await resolveDashboardWorkspaceContext(session.user.id);
  if (!workspaceContext?.workspaceMemberId) throw new CsvAccessError(403);

  // Export authorization follows the same active-workspace roster rule as the
  // alerts inventory. The legacy global Membership role is not sufficient: a
  // user may belong to multiple workspaces with different roles.
  const workspaceMember = await prisma.workspaceMember.findFirst({
    where: {
      id: workspaceContext.workspaceMemberId,
      workspaceId: workspaceContext.workspaceId,
      userId: session.user.id,
      status: 'active',
    },
    select: { role: true },
  });
  if (!workspaceMember || !hasAtLeast(workspaceMember.role, 'member')) {
    throw new CsvAccessError(403);
  }

  return { actorId: session.user.id, scopeId: workspaceContext.workspaceId };
}
