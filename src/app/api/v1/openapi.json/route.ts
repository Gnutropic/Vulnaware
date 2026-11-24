// @polsia:user-owned — GET /api/v1/openapi.json.
// Returns the static OpenAPI 3.1 document for the VulnAware enterprise REST
// API. No auth required — the spec contains no secrets. Content-Type is set
// automatically by NextResponse.json.

import 'server-only';
import { NextResponse } from 'next/server';
import { siteDescription, siteName } from '@/lib/brand';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// ── Reusable schema objects ───────────────────────────────────────────────────

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string', example: 'bad_request' },
    reason: { type: 'string', example: 'invalid id format' },
  },
  required: ['error'],
} as const;

const SCAN_HEADER_SCHEMA = {
  type: 'object',
  description: 'Compact metadata envelope for a single scan.',
  properties: {
    id: { type: 'string', example: 'scan_01hxyz' },
    target: { type: 'string', example: 'api.example.com' },
    mode: { type: 'string', example: 'tcp-only' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'completed', 'failed'],
      example: 'completed',
    },
    startedAt: { type: 'string', format: 'date-time', example: '2025-01-15T10:00:00.000Z' },
    finishedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      example: '2025-01-15T10:05:32.000Z',
    },
    teamId: { type: ['string', 'null'], example: 'team_01abc' },
  },
  required: ['id', 'target', 'mode', 'status', 'startedAt', 'finishedAt', 'teamId'],
} as const;

const MATCHED_ASSET_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'asset_01abc' },
    host: { type: 'string', example: 'api.example.com' },
    ip: { type: 'string', example: '93.184.216.34' },
    port: { type: 'integer', example: 443 },
    serviceHint: { type: ['string', 'null'], example: 'https' },
    banner: { type: ['string', 'null'], example: 'nginx/1.25.3' },
  },
  required: ['id', 'host', 'ip', 'port', 'serviceHint', 'banner'],
} as const;

const REMEDIATION_SCHEMA = {
  type: 'object',
  properties: {
    recommendedFix: {
      type: 'string',
      example: 'Upgrade OpenSSL to 3.0.8 or later.',
    },
    fixVersionOrPatch: { type: ['string', 'null'], example: '3.0.8' },
    verificationStep: {
      type: 'string',
      example: 'Run `openssl version` to confirm the upgrade.',
    },
    references: {
      type: 'array',
      items: { type: 'string' },
      example: ['https://nvd.nist.gov/vuln/detail/CVE-2023-0286'],
    },
  },
  required: ['recommendedFix', 'fixVersionOrPatch', 'verificationStep', 'references'],
} as const;

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    cveId: { type: 'string', example: 'CVE-2023-0286' },
    severity: { type: ['string', 'null'], example: 'HIGH' },
    cvssScore: { type: ['number', 'null'], example: 7.4 },
    epssScore: { type: ['number', 'null'], example: 0.00312 },
    epssPercentile: { type: ['number', 'null'], example: 0.61 },
    priorityScore: { type: ['number', 'null'], example: 82.3 },
    kevListed: { type: 'boolean', example: false },
    kevListedAt: { type: ['string', 'null'], format: 'date-time', example: null },
    matchReason: { type: 'string', example: 'banner fingerprint match: OpenSSL 3.0.0' },
    asset: MATCHED_ASSET_SCHEMA,
    remediation: REMEDIATION_SCHEMA,
  },
  required: [
    'cveId',
    'severity',
    'cvssScore',
    'epssScore',
    'epssPercentile',
    'priorityScore',
    'matchReason',
    'asset',
    'remediation',
  ],
} as const;

// Severity bucket counts. Used by POST /scan to expose a small pass/fail
// summary a PR comment can render in one line.
const SEVERITY_SUMMARY_SCHEMA = {
  type: 'object',
  description: 'Counts of findings per severity bucket; `total` is the sum.',
  properties: {
    critical: { type: 'integer', minimum: 0, example: 1 },
    high: { type: 'integer', minimum: 0, example: 2 },
    medium: { type: 'integer', minimum: 0, example: 4 },
    low: { type: 'integer', minimum: 0, example: 7 },
    total: { type: 'integer', minimum: 0, example: 14 },
  },
  required: ['critical', 'high', 'medium', 'low', 'total'],
} as const;

// Capped top-N projection of the full finding (drops fields a PR comment does
// not render) — paired with SCAN_HEADER_SCHEMA for the POST /scan response.
const CRITICAL_FINDING_SCHEMA = {
  type: 'object',
  description:
    'Top-N (max 10) of the CRITICAL findings, sorted by priority. The full list stays reachable via poll.findingsUrl.',
  properties: {
    cveId: { type: 'string', example: 'CVE-2023-0286' },
    severity: { type: 'string', example: 'CRITICAL' },
    priorityScore: { type: ['number', 'null'], example: 9.4 },
    asset: MATCHED_ASSET_SCHEMA,
    remediation: REMEDIATION_SCHEMA,
  },
  required: ['cveId', 'severity', 'priorityScore', 'asset', 'remediation'],
} as const;

const SCAN_TRIGGER_RESPONSE_SCHEMA = {
  type: 'object',
  description:
    'Scan header + verdict summary. `verdict` is `pass` when zero CRITICAL findings, `fail` when at least one CRITICAL, and `inconclusive` when the scan did not reach `completed` status (DNS error or aggregate budget exceeded).',
  properties: {
    id: { type: 'string', example: 'scan_01hxyz' },
    target: { type: 'string', example: 'api.example.com' },
    mode: { type: 'string', example: 'tcp-only' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'completed', 'failed'],
      example: 'completed',
    },
    startedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      example: '2025-01-15T10:00:00.000Z',
    },
    finishedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      example: '2025-01-15T10:05:32.000Z',
    },
    teamId: { type: ['string', 'null'], example: 'team_01abc' },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'inconclusive'],
      description: 'Tri-state verdict derived from status + critical count.',
      example: 'fail',
    },
    summary: SEVERITY_SUMMARY_SCHEMA,
    criticalFindings: {
      type: 'array',
      items: CRITICAL_FINDING_SCHEMA,
      maxItems: 10,
      description: 'Top-N (max 10) CRITICAL findings, sorted by priority.',
    },
    poll: {
      type: 'object',
      description: 'URLs into the existing /scans endpoints for full result retrieval.',
      properties: {
        scanUrl: { type: 'string', example: '/api/v1/scans/scan_01hxyz' },
        findingsUrl: { type: 'string', example: '/api/v1/scans/scan_01hxyz/findings' },
      },
      required: ['scanUrl', 'findingsUrl'],
    },
  },
  required: [
    'id',
    'target',
    'mode',
    'status',
    'startedAt',
    'finishedAt',
    'teamId',
    'verdict',
    'summary',
    'criticalFindings',
    'poll',
  ],
} as const;

const API_KEY_TEAM_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'team_01abc' },
    name: { type: 'string', example: 'system' },
  },
  required: ['id', 'name'],
} as const;

const API_KEY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'key_01abc' },
    name: { type: 'string', example: 'CI pipeline key' },
    scopeKind: { type: 'string', enum: ['team', 'scan'], example: 'team' },
    scanId: { type: ['string', 'null'], example: null },
    team: API_KEY_TEAM_SUMMARY_SCHEMA,
    createdAt: { type: 'string', format: 'date-time', example: '2025-01-10T08:00:00.000Z' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time', example: null },
    revokedAt: { type: ['string', 'null'], format: 'date-time', example: null },
  },
  required: ['id', 'name', 'scopeKind', 'scanId', 'team', 'createdAt', 'lastUsedAt', 'revokedAt'],
} as const;

const WEBHOOK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'wh_01abc' },
    url: { type: 'string', format: 'uri', example: 'https://hooks.example.com/vulnaware' },
    signingAlgorithm: {
      type: 'string',
      enum: ['hmac-sha256'],
      description:
        'Algorithm used to sign outbound webhook deliveries. Currently fixed at hmac-sha256.',
      example: 'hmac-sha256',
    },
    lastSignedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description: 'Timestamp of the most recent successful outbound delivery.',
      example: null,
    },
    createdAt: { type: 'string', format: 'date-time', example: '2025-01-10T08:00:00.000Z' },
    revokedAt: { type: ['string', 'null'], format: 'date-time', example: null },
    team: API_KEY_TEAM_SUMMARY_SCHEMA,
  },
  required: ['id', 'url', 'signingAlgorithm', 'lastSignedAt', 'createdAt', 'revokedAt', 'team'],
} as const;

// ── Reusable parameter / response fragments ───────────────────────────────────

const LIMIT_PARAM = {
  name: 'limit',
  in: 'query',
  description: 'Maximum number of results to return (1–500).',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
} as const;

const OFFSET_PARAM = {
  name: 'offset',
  in: 'query',
  description: 'Zero-based offset for pagination.',
  required: false,
  schema: { type: 'integer', minimum: 0, default: 0 },
} as const;

const COMMON_ERROR_RESPONSES = {
  400: {
    description: 'Bad request — invalid body or query parameters.',
    content: { 'application/json': { schema: ERROR_SCHEMA } },
  },
  401: {
    description: 'Unauthorized — missing or invalid API key.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'unauthorized' },
      },
    },
  },
  403: {
    description: 'Forbidden — authenticated but not authorized (wrong team or scan scope).',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        examples: {
          forbidden_other_team: {
            value: { error: 'forbidden_other_team' },
          },
          forbidden_other_scan: {
            value: { error: 'forbidden_other_scan' },
          },
        },
      },
    },
  },
  404: {
    description: 'Not found.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'not_found' },
      },
    },
  },
  500: {
    description: 'Internal server error.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'Internal Server Error' },
      },
    },
  },
  503: {
    description: 'Service unavailable — no API keys have been provisioned yet.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'api_key_not_configured' },
      },
    },
  },
} as const;

const ADMIN_ERROR_RESPONSES = {
  401: {
    description: 'Unauthorized — no valid admin session cookie.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'unauthorized' },
      },
    },
  },
  403: {
    description: 'Forbidden — authenticated but not an admin.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'forbidden' },
      },
    },
  },
  500: {
    description: 'Internal server error.',
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        example: { error: 'Internal Server Error' },
      },
    },
  },
} as const;

// ── Full spec ─────────────────────────────────────────────────────────────────

function buildSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: siteName,
      version: '1.0.0',
      description: siteDescription,
    },
    servers: [{ url: '/api/v1', description: 'VulnAware v1 REST API' }],
    security: [],
    components: {
      securitySchemes: {
        SessionCookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description: 'Admin session cookie (keys management only).',
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Team-scoped or scan-scoped API key.',
        },
      },
    },
    paths: {
      '/keys': {
        get: {
          operationId: 'listApiKeys',
          summary: 'List API keys',
          description:
            "Returns all non-revoked API keys for the calling admin's team. Requires an active admin session cookie.",
          tags: ['Keys'],
          security: [{ SessionCookieAuth: [] }],
          responses: {
            200: {
              description: 'List of API keys.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: {
                        type: 'array',
                        items: API_KEY_ITEM_SCHEMA,
                      },
                    },
                    required: ['items'],
                  },
                  example: {
                    items: [
                      {
                        id: 'key_01abc',
                        name: 'CI pipeline key',
                        scopeKind: 'team',
                        scanId: null,
                        team: { id: 'team_01abc', name: 'system' },
                        createdAt: '2025-01-10T08:00:00.000Z',
                        lastUsedAt: '2025-01-15T10:05:00.000Z',
                        revokedAt: null,
                      },
                    ],
                  },
                },
              },
            },
            ...ADMIN_ERROR_RESPONSES,
          },
        },
        post: {
          operationId: 'createApiKey',
          summary: 'Create API key',
          description:
            'Creates a new API key. The plaintext secret is returned once in the response and never again.',
          tags: ['Keys'],
          security: [{ SessionCookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      example: 'CI pipeline key',
                    },
                    scopeKind: {
                      type: 'string',
                      enum: ['team', 'scan'],
                      example: 'team',
                    },
                    scanId: {
                      type: 'string',
                      description: 'Required when scopeKind is "scan". Forbidden otherwise.',
                      example: null,
                    },
                  },
                  required: ['name', 'scopeKind'],
                },
              },
            },
          },
          responses: {
            201: {
              description: 'API key created. The `secret` field is a one-time plaintext value.',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      API_KEY_ITEM_SCHEMA,
                      {
                        type: 'object',
                        properties: {
                          secret: {
                            type: 'string',
                            description: 'One-time plaintext API key. Store it securely.',
                            example: 'va_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                          },
                        },
                        required: ['secret'],
                      },
                    ],
                  },
                },
              },
            },
            ...ADMIN_ERROR_RESPONSES,
          },
        },
      },
      '/keys/{id}': {
        delete: {
          operationId: 'revokeApiKey',
          summary: 'Revoke API key',
          description:
            'Soft-revokes an API key. The key is immediately invalidated. Returns 404 if the key does not exist or belongs to another team.',
          tags: ['Keys'],
          security: [{ SessionCookieAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'API key id.',
              schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
            },
          ],
          responses: {
            204: { description: 'Key successfully revoked. No content.' },
            409: {
              description: 'Key has already been revoked.',
              content: {
                'application/json': {
                  schema: ERROR_SCHEMA,
                  example: { error: 'already_revoked' },
                },
              },
            },
            ...ADMIN_ERROR_RESPONSES,
            404: {
              description: 'Not found (or belongs to another team — same posture).',
              content: {
                'application/json': {
                  schema: ERROR_SCHEMA,
                  example: { error: 'not_found' },
                },
              },
            },
          },
        },
      },
      '/scans': {
        get: {
          operationId: 'listScans',
          summary: 'List scans',
          description:
            "Returns a paginated list of scan headers for the bearing key's team. Scan-scope keys cannot use this endpoint (403 `forbidden_scope`).",
          tags: ['Scans'],
          security: [{ ApiKeyAuth: [] }],
          parameters: [LIMIT_PARAM, OFFSET_PARAM],
          responses: {
            200: {
              description: 'Paginated scan list.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: { type: 'array', items: SCAN_HEADER_SCHEMA },
                      limit: { type: 'integer', example: 50 },
                      offset: { type: 'integer', example: 0 },
                      total: { type: 'integer', example: 123 },
                    },
                    required: ['items', 'limit', 'offset', 'total'],
                  },
                  example: {
                    items: [
                      {
                        id: 'scan_01hxyz',
                        target: 'api.example.com',
                        mode: 'tcp-only',
                        status: 'completed',
                        startedAt: '2025-01-15T10:00:00.000Z',
                        finishedAt: '2025-01-15T10:05:32.000Z',
                        teamId: 'team_01abc',
                      },
                    ],
                    limit: 50,
                    offset: 0,
                    total: 1,
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/scans/{id}': {
        get: {
          operationId: 'getScan',
          summary: 'Get scan',
          description:
            'Returns the compact scan header for a single scan. Scan-scope keys see only the scan matching their `scanId`.',
          tags: ['Scans'],
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Scan id.',
              schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
            },
          ],
          responses: {
            200: {
              description: 'Scan header.',
              content: {
                'application/json': {
                  schema: SCAN_HEADER_SCHEMA,
                  example: {
                    id: 'scan_01hxyz',
                    target: 'api.example.com',
                    mode: 'tcp-only',
                    status: 'completed',
                    startedAt: '2025-01-15T10:00:00.000Z',
                    finishedAt: '2025-01-15T10:05:32.000Z',
                    teamId: 'team_01abc',
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/scans/{id}/findings': {
        get: {
          operationId: 'getScanFindings',
          summary: 'Get scan findings',
          description:
            'Returns paginated findings for a scan, sorted by priority (descending). Each finding includes asset context and actionable remediation guidance.',
          tags: ['Scans'],
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Scan id.',
              schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
            },
            LIMIT_PARAM,
            OFFSET_PARAM,
          ],
          responses: {
            200: {
              description: 'Paginated findings response.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      scan: SCAN_HEADER_SCHEMA,
                      findings: { type: 'array', items: FINDING_SCHEMA },
                      limit: { type: 'integer', example: 50 },
                      offset: { type: 'integer', example: 0 },
                      total: { type: 'integer', example: 7 },
                    },
                    required: ['scan', 'findings', 'limit', 'offset', 'total'],
                  },
                  example: {
                    scan: {
                      id: 'scan_01hxyz',
                      target: 'api.example.com',
                      mode: 'tcp-only',
                      status: 'completed',
                      startedAt: '2025-01-15T10:00:00.000Z',
                      finishedAt: '2025-01-15T10:05:32.000Z',
                      teamId: 'team_01abc',
                    },
                    findings: [
                      {
                        cveId: 'CVE-2023-0286',
                        severity: 'HIGH',
                        cvssScore: 7.4,
                        epssScore: 0.00312,
                        epssPercentile: 0.61,
                        priorityScore: 82.3,
                        kevListed: false,
                        kevListedAt: null,
                        matchReason: 'banner fingerprint match: OpenSSL 3.0.0',
                        asset: {
                          id: 'asset_01abc',
                          host: 'api.example.com',
                          ip: '93.184.216.34',
                          port: 443,
                          serviceHint: 'https',
                          banner: 'nginx/1.25.3',
                        },
                        remediation: {
                          recommendedFix: 'Upgrade OpenSSL to 3.0.8 or later.',
                          fixVersionOrPatch: '3.0.8',
                          verificationStep: 'Run `openssl version` to confirm the upgrade.',
                          references: ['https://nvd.nist.gov/vuln/detail/CVE-2023-0286'],
                        },
                      },
                    ],
                    limit: 50,
                    offset: 0,
                    total: 1,
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/webhooks': {
        get: {
          operationId: 'listWebhooks',
          summary: 'List webhooks',
          description:
            "Returns all non-revoked webhooks for the calling admin's team. Each item exposes the `signingAlgorithm` and the most recent `lastSignedAt` timestamp.",
          tags: ['Webhooks'],
          security: [{ SessionCookieAuth: [] }],
          responses: {
            200: {
              description: 'List of webhooks.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: { type: 'array', items: WEBHOOK_ITEM_SCHEMA },
                    },
                    required: ['items'],
                  },
                  example: {
                    items: [
                      {
                        id: 'wh_01abc',
                        url: 'https://hooks.example.com/vulnaware',
                        signingAlgorithm: 'hmac-sha256',
                        lastSignedAt: '2025-01-15T10:05:32.000Z',
                        createdAt: '2025-01-10T08:00:00.000Z',
                        revokedAt: null,
                        team: { id: 'team_01abc', name: 'system' },
                      },
                    ],
                  },
                },
              },
            },
            ...ADMIN_ERROR_RESPONSES,
          },
        },
        post: {
          operationId: 'createWebhook',
          summary: 'Register webhook',
          description:
            'Registers a webhook endpoint. The plaintext signing secret is returned once in the response and never again — store it securely on your side. The stored form is envelope-encrypted at rest; only this plaintext can be used to verify the X-VulnAware-Signature header on outbound deliveries.',
          tags: ['Webhooks'],
          security: [{ SessionCookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    url: {
                      type: 'string',
                      format: 'uri',
                      maxLength: 2048,
                      description: 'HTTPS URL that will receive POST deliveries.',
                      example: 'https://hooks.example.com/vulnaware',
                    },
                  },
                  required: ['url'],
                },
                example: { url: 'https://hooks.example.com/vulnaware' },
              },
            },
          },
          responses: {
            201: {
              description:
                'Webhook registered. The `secret` field is a one-time plaintext value (64 hex chars). Subsequent GETs do NOT include it.',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      WEBHOOK_ITEM_SCHEMA,
                      {
                        type: 'object',
                        properties: {
                          secret: {
                            type: 'string',
                            description:
                              'One-time plaintext signing secret. Store it securely — it will not be shown again.',
                            example:
                              '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c',
                          },
                        },
                        required: ['secret'],
                      },
                    ],
                  },
                },
              },
            },
            ...ADMIN_ERROR_RESPONSES,
          },
        },
      },
      '/webhooks/{id}': {
        delete: {
          operationId: 'revokeWebhook',
          summary: 'Revoke webhook',
          description:
            'Soft-revokes a webhook. Outbound deliveries to this endpoint stop immediately. Returns 404 if the webhook does not exist or belongs to another team.',
          tags: ['Webhooks'],
          security: [{ SessionCookieAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Webhook id.',
              schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
            },
          ],
          responses: {
            204: { description: 'Webhook revoked. No content.' },
            409: {
              description: 'Webhook has already been revoked.',
              content: {
                'application/json': {
                  schema: ERROR_SCHEMA,
                  example: { error: 'already_revoked' },
                },
              },
            },
            ...ADMIN_ERROR_RESPONSES,
            404: {
              description: 'Not found (or belongs to another team — same posture).',
              content: {
                'application/json': {
                  schema: ERROR_SCHEMA,
                  example: { error: 'not_found' },
                },
              },
            },
          },
        },
      },
      '/webhooks/trigger': {
        post: {
          operationId: 'triggerWebhook',
          summary: 'Trigger scan via webhook',
          description:
            "CI/CD intake endpoint. Accepts a build payload with a target hostname or repository URL, runs a vulnerability scan synchronously, and returns the scan header. Scan-scope keys cannot trigger new scans.\n\nEvery outbound webhook delivery to a registered endpoint includes the header `X-VulnAware-Signature: sha256=<hex>`, where `<hex>` is the HMAC-SHA256 of the raw JSON request body using the secret returned at registration time. The stored secret is never sent in the delivery.\n\nVerification snippet (Node.js):\n\n```js\nimport { createHmac, timingSafeEqual } from 'node:crypto';\n\nfunction verify(req, secret) {\n  const header = req.headers.get('x-vulnaware-signature') ?? '';\n  if (!header.startsWith('sha256=')) return false;\n  const expected = createHmac('sha256', secret).update(req.rawBody).digest();\n  const supplied = Buffer.from(header.slice('sha256='.length), 'hex');\n  return supplied.length === expected.length && timingSafeEqual(expected, supplied);\n}\n```\n\nFor PR-comment pass/fail integration (writing the verdict back to the pull request) use `POST /api/v1/scan`, which returns a verdict summary in the response body — designed for direct drop into `$GITHUB_STEP_SUMMARY` or similar CI comment surfaces. This endpoint is best when the caller prefers to poll `/scans/{id}/findings` out-of-band.",
          tags: ['Webhooks'],
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description:
                    'At least one of `target` or `repository.url` is required. All top-level keys are strict — unknown keys are rejected.',
                  properties: {
                    target: {
                      type: 'string',
                      description: 'Hostname or IP to scan.',
                      example: 'api.example.com',
                    },
                    ports: {
                      type: 'array',
                      items: { type: 'integer', minimum: 1, maximum: 65535 },
                      minItems: 1,
                      maxItems: 5,
                      description: 'Ports to probe. Allowed: 22, 80, 443, 8080, 8443.',
                      example: [443, 80],
                    },
                    repository: {
                      type: 'object',
                      properties: {
                        url: {
                          type: 'string',
                          format: 'uri',
                          example: 'https://github.com/acme/api',
                        },
                        ref: { type: 'string', example: 'main' },
                        commit: {
                          type: 'string',
                          example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
                        },
                      },
                    },
                    build: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: 'build-42' },
                        status: { type: 'string', example: 'success' },
                        branch: { type: 'string', example: 'main' },
                      },
                    },
                    mode: {
                      type: 'string',
                      enum: ['tcp-only'],
                      example: 'tcp-only',
                    },
                  },
                },
                example: {
                  target: 'api.example.com',
                  ports: [443],
                  repository: {
                    url: 'https://github.com/acme/api',
                    ref: 'main',
                    commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
                  },
                  build: { id: 'build-42', status: 'success', branch: 'main' },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Scan triggered and completed. Poll `/scans/{id}/findings` for results.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'scan_01hxyz' },
                      target: { type: 'string', example: 'api.example.com' },
                      mode: { type: 'string', example: 'tcp-only' },
                      status: {
                        type: 'string',
                        enum: ['queued', 'running', 'completed', 'failed'],
                        example: 'completed',
                      },
                      startedAt: {
                        type: ['string', 'null'],
                        format: 'date-time',
                        example: '2025-01-15T10:00:00.000Z',
                      },
                      finishedAt: {
                        type: ['string', 'null'],
                        format: 'date-time',
                        example: '2025-01-15T10:05:32.000Z',
                      },
                      teamId: { type: ['string', 'null'], example: 'team_01abc' },
                    },
                    required: [
                      'id',
                      'target',
                      'mode',
                      'status',
                      'startedAt',
                      'finishedAt',
                      'teamId',
                    ],
                  },
                },
              },
            },
            502: {
              description: 'Scan execution failed.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      code: { type: 'string', example: 'scan_failed' },
                      message: { type: 'string', example: 'scan failed' },
                    },
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/scan': {
        post: {
          operationId: 'triggerScan',
          summary: 'Trigger scan (PR-comment verdict summary)',
          description:
            'CI/CD scan trigger with a verdict-pruned response shape, designed for direct drop into a PR comment. Accepts the same payload as `POST /api/v1/webhooks/trigger` and runs the scan synchronously, but the response is a pass/fail summary instead of just the scan header so a CI step needs only one HTTP call to decide whether to block the merge.\n\nThe `verdict` is derived from the scan\'s terminal status plus the CRITICAL findings count:\n- `pass` — zero CRITICAL findings\n- `fail` — one or more CRITICAL findings\n- `inconclusive` — scan did not reach `completed` status (DNS error or the 8s aggregate probe budget was exceeded)\n\nTreat `inconclusive` as soft-fail in CI: the network or the budget failed, not the code. The OpenAPI spec documents the tri-state so CI consumers handle it explicitly; only `pass` and `fail` reflect actual exposure.\n\n### curl\n\n```bash\ncurl -X POST "$VULNAWARE_API/v1/scan" \\\n  -H "Authorization: Bearer $API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"target":"api.example.com","ports":[443]}\'\n```\n\n### GitHub Actions\n\n```yaml\n- name: VulnAware shift-left scan\n  env:\n    VULNAWARE_URL: https://app.vulnaware.example.com\n    VULNAWARE_API_KEY: ${{ secrets.VULNAWARE_API_KEY }}\n  run: |\n    response=$(curl -sS -X POST "${{ env.VULNAWARE_URL }}/api/v1/scan" \\\n      -H "x-api-key: ${{ env.VULNAWARE_API_KEY }}" \\\n      -H "Content-Type: application/json" \\\n      -d \'{"target":"${{ steps.deploy.target_host }}","ports":[443]}\')\n\n    verdict=$(echo "$response" | jq -r \'.verdict\')\n    critical=$(echo "$response" | jq -r \'.summary.critical\')\n    echo "## VulnAware scan — $verdict" >> "$GITHUB_STEP_SUMMARY"\n    echo "Critical findings: $critical" >> "$GITHUB_STEP_SUMMARY"\n\n    if [ "$verdict" = "fail" ]; then\n      echo "::error::VulnAware scan reported $critical critical finding(s)"\n      exit 1\n    fi\n```\n\nIf the same team has both `/webhooks/trigger` and `/scan` configured, each trigger fires one signed webhook delivery. Configure the CI step to use one path so duplicates do not arrive at the listening endpoint.',
          tags: ['Scans'],
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description:
                    'Same body as POST /api/v1/webhooks/trigger. At least one of `target` or `repository.url` is required. All top-level keys are strict.',
                  properties: {
                    target: {
                      type: 'string',
                      description: 'Hostname or IP to scan.',
                      example: 'api.example.com',
                    },
                    ports: {
                      type: 'array',
                      items: { type: 'integer', minimum: 1, maximum: 65535 },
                      minItems: 1,
                      maxItems: 5,
                      description: 'Ports to probe. Allowed: 22, 80, 443, 8080, 8443.',
                      example: [443, 80],
                    },
                    repository: {
                      type: 'object',
                      properties: {
                        url: {
                          type: 'string',
                          format: 'uri',
                          example: 'https://github.com/acme/api',
                        },
                        ref: { type: 'string', example: 'main' },
                        commit: {
                          type: 'string',
                          example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
                        },
                      },
                    },
                    build: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: 'build-42' },
                        status: { type: 'string', example: 'success' },
                        branch: { type: 'string', example: 'main' },
                      },
                    },
                    mode: { type: 'string', enum: ['tcp-only'], example: 'tcp-only' },
                  },
                },
                example: {
                  target: 'api.example.com',
                  ports: [443],
                  repository: {
                    url: 'https://github.com/acme/api',
                    ref: 'main',
                    commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
                  },
                  build: { id: 'build-42', status: 'success', branch: 'main' },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Scan triggered. The `verdict` field encodes pass/fail/inconclusive.',
              content: {
                'application/json': {
                  schema: SCAN_TRIGGER_RESPONSE_SCHEMA,
                  example: {
                    id: 'scan_01hxyz',
                    target: 'api.example.com',
                    mode: 'tcp-only',
                    status: 'completed',
                    startedAt: '2025-01-15T10:00:00.000Z',
                    finishedAt: '2025-01-15T10:05:32.000Z',
                    teamId: 'team_01abc',
                    verdict: 'fail',
                    summary: { critical: 1, high: 2, medium: 4, low: 7, total: 14 },
                    criticalFindings: [
                      {
                        cveId: 'CVE-2023-0286',
                        severity: 'CRITICAL',
                        priorityScore: 9.4,
                        asset: {
                          id: 'asset_01abc',
                          host: 'api.example.com',
                          ip: '93.184.216.34',
                          port: 443,
                          serviceHint: 'https',
                          banner: 'openssl/3.0.7',
                        },
                        remediation: {
                          recommendedFix: 'Upgrade OpenSSL to >= 3.0.8.',
                          fixVersionOrPatch: 'OpenSSL >= 3.0.8',
                          verificationStep: 'Run `openssl version` to confirm the upgrade.',
                          references: ['https://nvd.nist.gov/vuln/detail/CVE-2023-0286'],
                        },
                      },
                    ],
                    poll: {
                      scanUrl: '/api/v1/scans/scan_01hxyz',
                      findingsUrl: '/api/v1/scans/scan_01hxyz/findings',
                    },
                  },
                },
              },
            },
            502: {
              description:
                'Scan execution failed. The route surfaces this as a `scan_failed` envelope so a CI step can treat 502 as inconclusive without failing the PR step.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      code: { type: 'string', example: 'scan_failed' },
                      message: { type: 'string', example: 'scan failed' },
                    },
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/aws/discover': {
        post: {
          operationId: 'awsDiscover',
          summary: 'Trigger AWS asset discovery',
          description:
            'Queues an AWS asset discovery run for the specified connection. Returns a run id and a poll URL.',
          tags: ['Cloud Discovery'],
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connectionId: {
                      type: 'string',
                      minLength: 1,
                      example: 'aws_conn_01abc',
                    },
                    regions: {
                      type: 'array',
                      items: {
                        type: 'string',
                        pattern: '^[a-z]{2}(-[a-z]+)+-[0-9]$',
                      },
                      maxItems: 20,
                      description:
                        'AWS regions to enumerate. Defaults to the regions stored on the connection.',
                      example: ['us-east-1', 'eu-west-1'],
                    },
                  },
                  required: ['connectionId'],
                },
                example: { connectionId: 'aws_conn_01abc', regions: ['us-east-1'] },
              },
            },
          },
          responses: {
            201: {
              description: 'Discovery run queued.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'aws_run_01xyz' },
                      status: {
                        type: 'string',
                        enum: ['queued', 'running', 'succeeded', 'failed'],
                        example: 'queued',
                      },
                      pollUrl: {
                        type: 'string',
                        example: '/api/v1/aws/discover/aws_run_01xyz',
                      },
                    },
                    required: ['id', 'status', 'pollUrl'],
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/azure/discover': {
        post: {
          operationId: 'azureDiscover',
          summary: 'Trigger Azure asset discovery',
          description:
            'Queues an Azure asset discovery run for the specified connection. Returns a run id and a poll URL.',
          tags: ['Cloud Discovery'],
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connectionId: {
                      type: 'string',
                      minLength: 1,
                      example: 'az_conn_01abc',
                    },
                    locations: {
                      type: 'array',
                      items: { type: 'string', pattern: '^[a-z]+[0-9a-z]*$' },
                      maxItems: 20,
                      description:
                        'Azure locations to enumerate. Defaults to the locations stored on the connection.',
                      example: ['eastus', 'westeurope'],
                    },
                  },
                  required: ['connectionId'],
                },
                example: { connectionId: 'az_conn_01abc', locations: ['eastus'] },
              },
            },
          },
          responses: {
            201: {
              description: 'Discovery run queued.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'az_run_01xyz' },
                      status: {
                        type: 'string',
                        enum: ['queued', 'running', 'succeeded', 'failed'],
                        example: 'queued',
                      },
                      pollUrl: {
                        type: 'string',
                        example: '/api/v1/azure/discover/az_run_01xyz',
                      },
                    },
                    required: ['id', 'status', 'pollUrl'],
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
      '/gcp/discover': {
        post: {
          operationId: 'gcpDiscover',
          summary: 'Trigger GCP asset discovery',
          description:
            'Queues a GCP asset discovery run for the specified connection. Returns a run id and a poll URL.',
          tags: ['Cloud Discovery'],
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    connectionId: {
                      type: 'string',
                      minLength: 1,
                      example: 'gcp_conn_01abc',
                    },
                    zones: {
                      type: 'array',
                      items: {
                        type: 'string',
                        pattern: '^[a-z]+-[a-z]+[0-9]+-[a-z]$',
                      },
                      maxItems: 20,
                      description:
                        'GCP zones to enumerate. Defaults to the zones stored on the connection.',
                      example: ['us-central1-a', 'europe-west2-b'],
                    },
                  },
                  required: ['connectionId'],
                },
                example: { connectionId: 'gcp_conn_01abc', zones: ['us-central1-a'] },
              },
            },
          },
          responses: {
            201: {
              description: 'Discovery run queued.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'gcp_run_01xyz' },
                      status: {
                        type: 'string',
                        enum: ['queued', 'running', 'succeeded', 'failed'],
                        example: 'queued',
                      },
                      pollUrl: {
                        type: 'string',
                        example: '/api/v1/gcp/discover/gcp_run_01xyz',
                      },
                    },
                    required: ['id', 'status', 'pollUrl'],
                  },
                },
              },
            },
            ...COMMON_ERROR_RESPONSES,
          },
        },
      },
    },
  };
}

export async function GET(req: Request) {
  return withRateLimit(req, () => Promise.resolve(NextResponse.json(buildSpec())));
}
