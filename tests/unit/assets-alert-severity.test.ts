// @vitest-environment node
// @polsia:user-owned — Active-workspace unresolved severity aggregation coverage.

import { describe, expect, it } from 'vitest';
import {
  bucketAssetSeverity,
  highestUnresolvedSeverityByHost,
  type AssetAlertSeverityCandidate,
} from '@/lib/business/assets-alert-severity';

const activeWorkspaceId = 'workspace-active';

function candidate(
  host: string,
  severity: string | null,
  status: string,
  teamId = activeWorkspaceId,
): AssetAlertSeverityCandidate {
  return { host, severity, status, teamId };
}

describe('asset unresolved severity selector', () => {
  it('uses the highest severity among open and in-progress alerts only', () => {
    const highestByHost = highestUnresolvedSeverityByHost(
      [
        candidate('api.example.test', 'medium', 'in_progress'),
        candidate('api.example.test', 'HIGH', 'open'),
        candidate('api.example.test', 'critical', 'resolved'),
        candidate('urgent.example.test', 'high', 'open'),
        candidate('urgent.example.test', 'critical', 'in_progress'),
        candidate('resolved-only.example.test', 'critical', 'resolved'),
      ],
      activeWorkspaceId,
    );

    expect(highestByHost.get('api.example.test')).toBe('high');
    expect(highestByHost.get('urgent.example.test')).toBe('critical');
    expect(highestByHost.has('resolved-only.example.test')).toBe(false);
  });

  it('buckets null and unknown severities as low', () => {
    expect(bucketAssetSeverity(null)).toBe('low');
    expect(bucketAssetSeverity('unrecognized')).toBe('low');
    expect(
      highestUnresolvedSeverityByHost(
        [
          candidate('legacy.example.test', 'unrecognized', 'open'),
          candidate('legacy.example.test', null, 'in_progress'),
        ],
        activeWorkspaceId,
      ).get('legacy.example.test'),
    ).toBe('low');
  });

  it('ignores a same-host critical alert from a different workspace', () => {
    const highestByHost = highestUnresolvedSeverityByHost(
      [
        candidate('shared.example.test', 'medium', 'open', activeWorkspaceId),
        candidate('shared.example.test', 'critical', 'in_progress', 'workspace-foreign'),
      ],
      activeWorkspaceId,
    );

    expect(highestByHost.get('shared.example.test')).toBe('medium');
  });
});
