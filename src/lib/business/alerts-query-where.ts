// @polsia:user-owned — Shared active-workspace alert predicates for the list and CSV export.

import type { Prisma } from '@prisma/client';
import { buildAlertCreatedAtRange } from '@/lib/business/alerts-created-at-range';
import { parseSeverityFilter } from '@/lib/business/alerts-severity';
import { sinceToBoundDate } from '@/lib/business/alerts-since';
import { HIGH_RISK_PRIORITY_SCORE } from '@/lib/business/scanner/prioritize';
import type { AlertQuery } from '@/lib/contracts/alerts';

type AlertQueryValues = AlertQuery;
type AlertFilterValues = Pick<
  AlertQueryValues,
  | 'resolution'
  | 'severity'
  | 'source'
  | 'triggeredBy'
  | 'status'
  | 'acknowledged'
  | 'assigneeReady'
  | 'hideSnoozed'
  | 'highRiskAssets'
  | 'q'
  | 'hostname'
  | 'asset'
  | 'from'
  | 'to'
  | 'since'
> & {
  ownedByMe?: '1';
  remediated?: '1';
  snoozed?: '1';
};

export interface BuildAlertsWhereInput {
  teamId: string;
  workspaceMemberId: string | null;
  filters: AlertFilterValues;
  searchFinding?: Prisma.VulnerabilityFindingWhereInput;
  assetOrList?: readonly { host: string; port: number; protocol: string }[];
  now?: Date;
}

export interface AlertsWhereResult {
  countsWhere: Prisma.AlertWhereInput;
  where: Prisma.AlertWhereInput;
}

export function buildAlertsWhere(input: BuildAlertsWhereInput): AlertsWhereResult {
  const { filters } = input;
  const now = input.now ?? new Date();
  const openOnly = filters.status === 'open';
  const wireStatus = openOnly ? undefined : filters.status;
  const status = wireStatus === 'snoozed' || wireStatus == null ? undefined : wireStatus;
  const resolutionWhere: Prisma.AlertWhereInput =
    filters.resolution === 'resolved'
      ? { status: 'resolved' }
      : filters.resolution === 'unresolved'
        ? { status: { not: 'resolved' } }
        : {};
  const severityIn = parseSeverityFilter(filters.severity ?? null);
  const assetOrList = input.assetOrList ?? [];
  const searchAsset = input.searchFinding?.asset as Prisma.AssetWhereInput | undefined;
  const combinedAssetWhere: Prisma.AssetWhereInput | undefined =
    assetOrList.length > 0 ? { ...(searchAsset ?? {}), OR: [...assetOrList] } : searchAsset;

  const snoozeArms: Prisma.AlertWhereInput[] =
    filters.hideSnoozed === '1' ? [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] : [];
  const sinceArms: Prisma.AlertWhereInput[] = filters.since
    ? [
        { createdAt: { gte: sinceToBoundDate(filters.since, now) } },
        { statusChangedAt: { gte: sinceToBoundDate(filters.since, now) } },
      ]
    : [];
  const assigneeReadyFalseArms: Prisma.AlertWhereInput[] =
    filters.assigneeReady === false
      ? [{ acknowledgedAt: { not: null } }, { assigneeId: { not: null } }]
      : [];
  const rootOrArms = [...snoozeArms, ...sinceArms, ...assigneeReadyFalseArms];
  const andFilters: Prisma.AlertWhereInput[] = [
    ...(openOnly && rootOrArms.length > 0 ? [{ OR: rootOrArms }] : []),
    ...(filters.resolution &&
    filters.resolution !== 'all' &&
    (openOnly || wireStatus === 'snoozed' || status !== undefined)
      ? [resolutionWhere]
      : []),
  ];
  const createdAtRange = buildAlertCreatedAtRange(filters.from, filters.to);

  const countsWhere: Prisma.AlertWhereInput = {
    teamId: input.teamId,
    ...(filters.source ? { source: filters.source } : {}),
    ...(openOnly
      ? {
          status: 'open',
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
        }
      : wireStatus === 'snoozed'
        ? {
            snoozedUntil: { gt: now },
            ...(rootOrArms.length > 0 ? { OR: rootOrArms } : {}),
          }
        : {
            ...(status
              ? { status }
              : filters.resolution === 'all'
                ? {}
                : filters.resolution === 'resolved'
                  ? { status: 'resolved' as const }
                  : { status: { not: 'resolved' as const } }),
            ...(rootOrArms.length > 0 ? { OR: rootOrArms } : {}),
          }),
    ...(andFilters.length > 0 ? { AND: andFilters } : {}),
    ...(filters.acknowledged === true ? { acknowledgedAt: { not: null } } : {}),
    ...(filters.acknowledged === false ? { acknowledgedAt: null } : {}),
    ...(filters.assigneeReady === true ? { acknowledgedAt: null, assigneeId: null } : {}),
    ...(filters.triggeredBy ||
    filters.q ||
    filters.hostname ||
    assetOrList.length > 0 ||
    filters.highRiskAssets
      ? {
          finding: {
            ...(filters.triggeredBy ? { scan: { source: filters.triggeredBy } } : {}),
            ...(input.searchFinding ?? {}),
            ...(combinedAssetWhere ? { asset: combinedAssetWhere } : {}),
            ...(filters.highRiskAssets ? { priorityScore: { gte: HIGH_RISK_PRIORITY_SCORE } } : {}),
          },
        }
      : {}),
    ...(createdAtRange ? { createdAt: createdAtRange } : {}),
    ...(input.filters.ownedByMe === '1'
      ? { ownerId: { in: input.workspaceMemberId ? [input.workspaceMemberId] : [] } }
      : {}),
    ...(input.filters.remediated === '1' ? { remediatedAt: { not: null } } : {}),
    ...(input.filters.snoozed === '1' ? { snoozedUntil: { gt: now } } : {}),
  };

  return {
    countsWhere,
    where: { ...countsWhere, ...(severityIn.length > 0 ? { severity: { in: severityIn } } : {}) },
  };
}
