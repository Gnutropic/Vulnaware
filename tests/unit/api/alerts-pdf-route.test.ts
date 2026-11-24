// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_GUIDANCE,
  mapAlertPdfDocument,
  parseCachedAlertFixSteps,
  type AlertPdfInput,
} from '@/lib/business/alerts/pdf-render';

const {
  requireMemberMock,
  alertFindFirstMock,
  teamFindUniqueMock,
  cveEntryFindUniqueMock,
  fixFindFirstMock,
  noteFindManyMock,
  commentFindManyMock,
  workspaceMemberFindFirstMock,
  userFindManyMock,
  userFindUniqueMock,
  renderDocumentPdfMock,
  setRequestAuthMock,
} = vi.hoisted(() => ({
  requireMemberMock: vi.fn(),
  alertFindFirstMock: vi.fn(),
  teamFindUniqueMock: vi.fn(),
  cveEntryFindUniqueMock: vi.fn(),
  fixFindFirstMock: vi.fn(),
  noteFindManyMock: vi.fn(),
  commentFindManyMock: vi.fn(),
  workspaceMemberFindFirstMock: vi.fn(),
  userFindManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  renderDocumentPdfMock: vi.fn(),
  setRequestAuthMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/brand', () => ({ brand: { name: 'VulnAware' } }));
vi.mock('@/lib/business/alert-workspace-access', () => ({
  requireAlertWorkspaceMember: requireMemberMock,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    alert: { findFirst: alertFindFirstMock },
    team: { findUnique: teamFindUniqueMock },
    cveEntry: { findUnique: cveEntryFindUniqueMock },
    alertCveFix: { findFirst: fixFindFirstMock },
    alertNote: { findMany: noteFindManyMock },
    alertComment: { findMany: commentFindManyMock },
    workspaceMember: { findFirst: workspaceMemberFindFirstMock },
    user: { findMany: userFindManyMock, findUnique: userFindUniqueMock },
  },
}));
vi.mock('@/lib/pdf/client', () => ({ renderDocumentPdf: renderDocumentPdfMock }));
vi.mock('@/lib/logging/with-request', () => ({
  setRequestAuth: setRequestAuthMock,
  withApiRequest: (_request: Request, handler: () => Promise<Response>) => handler(),
}));

import {
  DELETE,
  GET,
  PATCH,
  POST,
  PUT,
} from '@/app/api/alerts/[id]/pdf/route';

const memberContext = {
  user: { id: 'user-1' },
  workspaceId: 'workspace-1',
  workspaceMemberId: 'member-1',
};

function makeAlert() {
  return {
    id: 'alert-1',
    teamId: 'workspace-1',
    createdAt: new Date('2026-09-30T10:00:00.000Z'),
    severity: 'high',
    status: 'open',
    source: 'kev',
    ownerId: null,
    acknowledgedAt: null,
    snoozedUntil: null,
    remediatedAt: null,
    remediatedByEmail: null,
    closedAt: null,
    closedBy: null,
    closingNote: null,
    falsePositiveReason: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    finding: {
      cveId: 'CVE-2026-0001',
      lastRescoreAt: new Date('2026-10-01T10:00:00.000Z'),
      epssScore: 0.123,
      asset: { host: 'edge.example.test', ip: '192.0.2.10', port: 443, protocol: 'tcp' },
      scan: { source: 'scheduled' },
    },
  };
}

function request(method = 'GET') {
  return GET(new Request('http://test/api/alerts/alert-1/pdf', { method }), {
    params: Promise.resolve({ id: 'alert-1' }),
  });
}

function validCache() {
  return {
    fixStepsJson: JSON.stringify([
      { id: 'step-1', title: 'Review exposure', body: 'Confirm the affected service.' },
      { id: 'step-2', title: 'Plan remediation', body: 'Use the guidance available for this CVE.' },
    ]),
    promptVersion: 'v2-alert-context-only',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireMemberMock.mockResolvedValue(memberContext);
  alertFindFirstMock.mockResolvedValue(makeAlert());
  teamFindUniqueMock.mockResolvedValue({ name: 'Security workspace' });
  cveEntryFindUniqueMock.mockResolvedValue({
    cvssScore: 8.1,
    description: 'A vulnerability in the exposed service.',
  });
  fixFindFirstMock.mockResolvedValue(null);
  noteFindManyMock.mockResolvedValue([]);
  commentFindManyMock.mockResolvedValue([]);
  workspaceMemberFindFirstMock.mockResolvedValue(null);
  userFindManyMock.mockResolvedValue([]);
  userFindUniqueMock.mockResolvedValue(null);
  renderDocumentPdfMock.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
});

describe('GET /api/alerts/[id]/pdf', () => {
  it('returns 401 before reading alerts for anonymous callers', async () => {
    requireMemberMock.mockRejectedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const response = await request();

    expect(response.status).toBe(401);
    expect(alertFindFirstMock).not.toHaveBeenCalled();
    expect(renderDocumentPdfMock).not.toHaveBeenCalled();
  });

  it('returns an opaque 404 for a non-member without rendering a PDF', async () => {
    requireMemberMock.mockRejectedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));

    const response = await request();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(alertFindFirstMock).not.toHaveBeenCalled();
    expect(renderDocumentPdfMock).not.toHaveBeenCalled();
  });

  it('returns an opaque 404 for a cross-workspace id using a scoped lookup', async () => {
    alertFindFirstMock.mockResolvedValueOnce(null);

    const response = await request();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(alertFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'alert-1', teamId: 'workspace-1' } }),
    );
    expect(renderDocumentPdfMock).not.toHaveBeenCalled();
  });

  it('returns a scoped PDF attachment for an authorized member', async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="alert-alert-1.pdf"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(alertFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'alert-1', teamId: 'workspace-1' } }),
    );
    expect(renderDocumentPdfMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'stale', cache: { fixStepsJson: JSON.stringify([{ id: 'old', title: 'Old', body: 'Old' }]), promptVersion: 'v1' } },
    { label: 'malformed', cache: { fixStepsJson: '{not-json', promptVersion: 'v2-alert-context-only' } },
    { label: 'empty', cache: { fixStepsJson: JSON.stringify([]), promptVersion: 'v2-alert-context-only' } },
  ])('renders explicit unavailable guidance for $label cache data', async ({ cache }) => {
    fixFindFirstMock.mockResolvedValueOnce(cache);

    await request();

    const document = renderDocumentPdfMock.mock.calls[0]?.[0] as { notes: string };
    expect(document.notes).toContain(EMPTY_GUIDANCE);
  });

  it('includes valid cached steps beneath the AI-generated guidance heading', async () => {
    fixFindFirstMock.mockResolvedValueOnce(validCache());

    await request();

    const document = renderDocumentPdfMock.mock.calls[0]?.[0] as { notes: string };
    const heading = document.notes.indexOf('AI-generated remediation guidance');
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(document.notes.indexOf('Review exposure')).toBeGreaterThan(heading);
    expect(document.notes.indexOf('Plan remediation')).toBeGreaterThan(heading);
    expect(document.notes).not.toContain(EMPTY_GUIDANCE);
  });
});

describe('alert PDF document mapping', () => {
  const input: AlertPdfInput = {
    brandName: 'VulnAware',
    teamName: 'Security workspace',
    generatedAt: '2026-10-07T12:00:00.000Z',
    createdAt: '2026-09-30T10:00:00.000Z',
    alertId: 'alert-1',
    cveId: 'CVE-2026-0001',
    cvssScore: 8.1,
    epssScore: 0.123,
    description: 'A vulnerability in the exposed service.',
    severity: 'high',
    source: 'kev',
    triggeredBy: 'scheduled',
    status: 'open',
    snoozedUntil: null,
    acknowledgedAt: null,
    remediatedAt: null,
    remediatedByEmail: null,
    closedAt: null,
    closedBy: null,
    closingNote: null,
    falsePositiveReason: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    ownerName: null,
    ownerEmail: null,
    asset: { host: 'edge.example.test', ip: '192.0.2.10', port: 443, protocol: 'tcp', lastSeen: null },
    notes: [],
    comments: [],
    fixSteps: [{ title: 'Review exposure', body: 'Confirm the affected service.' }],
  };

  it('maps core facts, lifecycle fields, and guidance into a DocumentSpec', () => {
    const document = mapAlertPdfDocument(input);
    const meta = new Map(document.meta?.map((row) => [row.label, row.value]));

    expect(meta.get('Alert ID')).toBe('alert-1');
    expect(meta.get('CVE')).toBe('CVE-2026-0001');
    expect(meta.get('Host')).toBe('edge.example.test');
    expect(meta.get('EPSS')).toBe('0.123');
    expect(document.notes).toContain('Vulnerability description');
    expect(document.notes).toContain('AI-generated remediation guidance');
    expect(document.notes).toContain('Review exposure');
    expect(document.footer).toContain('no remediation outcome is asserted');
  });

  it('includes projected lifecycle actors and reasons with em-dash fallbacks', () => {
    const populated = mapAlertPdfDocument({
      ...input,
      remediatedByEmail: 'operator@example.test',
      closedBy: 'user-closed',
      closingNote: 'Patched the affected service.',
      falsePositiveReason: 'Not reachable from the monitored boundary.',
      reopenedBy: 'user-reopened',
      reopenReason: 'Follow-up validation found the issue still present.',
    });
    const populatedMeta = new Map(populated.meta?.map((row) => [row.label, row.value]));

    expect(populatedMeta.get('Remediated by')).toBe('operator@example.test');
    expect(populatedMeta.get('Closed by')).toBe('user-closed');
    expect(populatedMeta.get('Closing note')).toBe('Patched the affected service.');
    expect(populatedMeta.get('False-positive reason')).toBe(
      'Not reachable from the monitored boundary.',
    );
    expect(populatedMeta.get('Reopened by')).toBe('user-reopened');
    expect(populatedMeta.get('Reopen reason')).toBe(
      'Follow-up validation found the issue still present.',
    );

    const emptyMeta = new Map(mapAlertPdfDocument(input).meta?.map((row) => [row.label, row.value]));
    expect(emptyMeta.get('Remediated by')).toBe('—');
    expect(emptyMeta.get('Closing note')).toBe('—');
    expect(emptyMeta.get('Reopen reason')).toBe('—');
  });

  it('rejects stale, malformed, and wrong-shaped guidance caches', () => {
    const valid = JSON.stringify([{ id: 'step-1', title: 'Title', body: 'Body' }]);
    expect(parseCachedAlertFixSteps(valid, 'v1')).toEqual([]);
    expect(parseCachedAlertFixSteps('{bad', 'v2-alert-context-only')).toEqual([]);
    expect(parseCachedAlertFixSteps(JSON.stringify([{ title: 'Title', body: 'Body' }]), 'v2-alert-context-only')).toEqual([]);
    expect(parseCachedAlertFixSteps(valid, 'v2-alert-context-only')).toEqual([
      { title: 'Title', body: 'Body' },
    ]);
  });
});

describe('unsupported methods for alert PDF export', () => {
  it.each([
    ['POST', POST],
    ['PUT', PUT],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ])('rejects %s without reading alert data', async (_method, handler) => {
    const response = await handler();

    expect(response.status).toBe(405);
    expect(alertFindFirstMock).not.toHaveBeenCalled();
    expect(renderDocumentPdfMock).not.toHaveBeenCalled();
  });
});
