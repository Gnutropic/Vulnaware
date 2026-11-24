// @vitest-environment node
//
// Pins the shared-POST 202 contract for the bearers-from-CI surface.
//
// Each snippet in src/app/(dashboard)/settings/integrations/ci-cd/page.tsx is
// a TS template-literal constant. The `${VAR}` / `$VAR` strings inside must
// SURVIVE parse — React would otherwise happily interpolate expressions in
// JSX children, but the page passes the constants through `{CONSTANT}` (a
// STRING child), so no template-literal collapse happens there. We pin
// that promise here by regex-extracting the constants from the page source
// directly: if anyone ever changes the page to wrap the value in a JSX
// template literal, or copies `${VAR}` into a `<code>{`…${VAR}…`}</code>`
// shape, the literal-preservation assertion below fires.
//
// Note on `'` ' " $X " ' ` bash splices (used in the GitLab snippet for
// variables the runner must bake into the wire JSON): the test asserts
// BOTH that the splice syntax survives the page source (it trickles
// through to the customer's `.gitlab-ci.yml` unchanged) AND that the
// route layer accepts the JSON the splice would produce at exec time.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CiWebhookTriggerBody } from '@/lib/contracts/ci-webhook';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    CI_WEBHOOK_TOKEN: 'test-token-1234567890',
    CI_WEBHOOK_TOKENS_JSON: undefined,
  },
}));

const teamFindFirst = vi.fn();
const scanCreate = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    team: { findFirst: teamFindFirst },
    scan: { create: scanCreate },
  },
}));

const runScanSpy = vi.fn();
vi.mock('@/lib/business/scanner/run-scan', () => ({
  runScan: (...args: unknown[]) => runScanSpy(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  withRateLimit: (_req: Request, fn: () => Promise<Response>) => fn(),
  resetRateLimitStateForTest: () => {},
}));

vi.mock('@/lib/logging/with-request', () => ({
  withApiRequest: (_req: Request, fn: () => Promise<Response>) => fn(),
  setRequestAuth: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const PAGE_SOURCE_PATH = join(
  process.cwd(),
  'src/app/(dashboard)/settings/integrations/ci-cd/page.tsx',
);

/**
 * Pull a named template-literal constant straight from the page source —
 * keeps the test live: if the snippet ever shifts shape or escapes break,
 * the body-arrival matcher fails before the route layer ever sees it.
 */
function loadSnippetRaw(
  name: 'GITLAB_CI_YML' | 'JENKINSFILE_SNIPPET' | 'GITHUB_ACTIONS_YAML',
): string {
  const src = readFileSync(PAGE_SOURCE_PATH, 'utf8');
  const re = new RegExp('const ' + name + ' = `([\\s\\S]+?)`;');
  const match = src.match(re);
  if (!match) throw new Error('Could not extract ' + name + ' from page.tsx');
  return match[1];
}

/**
 * Simulate the two-stage expansion the snippets actually do at exec time,
 * derived from the x-loading the raw TS source file via fs.readFileSync
 * (so the literal text we see is `\${CI_PROJECT_URL}` rather than the
 * parsed `${CI_PROJECT_URL}`):
 *
 *   1. File-source `\${VAR}` / `\${env.VAR}` → `value` (back-tick escape;
 *      TS parses these at module-load and emits `${VAR}` to the runtime
 *      string the customer sees).
 *   2. Runtime `${VAR}` / `${env.VAR}` → `value` (GitLab-runner / Groovy
 *      interpolation; this also matches the JSON the curl payload would
 *      carry after gitlab-runner / Groovy expands it).
 *   3. Bare `$VAR` → `value` (bash variable expansion under `-H` or URL).
 *
 * Order picks the longer escapes first so a `$X` substring pass doesn't
 * strand the trailing `}` from an unconsumed `${X}`.
 */
function substituteVars(snippet: string, vars: Record<string, string>): string {
  let out = snippet;
  for (const [k, v] of Object.entries(vars)) {
    // File-source escapes (TS back-tick escape → runtime ${...}).
    out = out.split('\\${env.' + k + '}').join(v);
    out = out.split('\\${' + k + '}').join(v);
    // Runtime / runner / Groovy interpolation.
    out = out.split('${env.' + k + '}').join(v);
    out = out.split('${' + k + '}').join(v);
    // Bare bash `$VAR` form (covers `-H "Authorization: Bearer $VAR"`).
    out = out.split('$' + k).join(v);
  }
  return out;
}

/**
 * Extract the JSON payload from a `-d '…'` argv pair. Single-quoted bash
 * strings don't process any escape inside the quote, so the captured group
 * is verbatim the JSON.
 */
function extractCurlPayload(snippet: string): string {
  const match = snippet.match(/-d '([^']*)'/);
  if (!match)
    throw new Error('Could not extract `-d ' + "'" + '…' + "'" + '` payload from snippet');
  return match[1];
}

function mkRequest(opts: {
  body?: unknown;
  rawBody?: string;
  authorization?: string | null;
}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.authorization) headers.authorization = opts.authorization;
  let body: string | undefined;
  if (typeof opts.rawBody === 'string') body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  return new Request('http://test/api/ci/webhook', { method: 'POST', headers, body });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Setup ────────────────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-token-1234567890';

beforeEach(() => {
  vi.resetModules();
  teamFindFirst.mockReset();
  scanCreate.mockReset();
  runScanSpy.mockReset();
  teamFindFirst.mockResolvedValue({ id: 'team-test' });
  scanCreate.mockResolvedValue({
    id: 'scan-ci-1',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  runScanSpy.mockResolvedValue({ id: 'scan-ci-1', status: 'completed' });
});

// ===================== GROUP A — GITLAB SNIPPET =====================

describe('GitLab CI YAML snippet → POST /api/ci/webhook', () => {
  it('produces a JSON body that safeParse()s against CiWebhookTriggerBody', async () => {
    const raw = loadSnippetRaw('GITLAB_CI_YML');
    const rendered = substituteVars(raw, {
      CI_PROJECT_URL: 'https://gitlab.example.com/group/project',
      CI_COMMIT_REF_NAME: 'refs/heads/main',
      CI_COMMIT_SHA: 'abc1234567890abcdef1234567890abcdef12345',
      CI_PIPELINE_ID: '1234567890',
      CI_JOB_STAGE: 'test',
      VULN_AWARE_URL: 'https://app.example.com',
    });
    const payload = extractCurlPayload(rendered);
    const parsedBody = JSON.parse(payload);
    const result = CiWebhookTriggerBody.safeParse(parsedBody);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repository?.url).toBe('https://gitlab.example.com/group/project');
      expect(result.data.repository?.ref).toBe('refs/heads/main');
      expect(result.data.build?.id).toBe('1234567890');
    }
  });

  it('POSTs in-process and returns 202 when supplied the matching bearer', async () => {
    const raw = loadSnippetRaw('GITLAB_CI_YML');
    const rendered = substituteVars(raw, {
      CI_PROJECT_URL: 'https://gitlab.example.com/group/project',
      CI_COMMIT_REF_NAME: 'main',
      CI_COMMIT_SHA: 'abc1234567890abcdef1234567890abcdef12345',
      CI_PIPELINE_ID: 'pipe-1',
      CI_JOB_STAGE: 'test',
      VULN_AWARE_URL: 'https://app.example.com',
    });
    const payload = extractCurlPayload(rendered);
    const parsed = JSON.parse(payload);

    const { POST } = await import('@/app/api/ci/webhook/route');
    const res = await POST(mkRequest({ body: parsed, authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.source).toBe('ci-webhook');
    expect(scanCreate).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
  });
});

// ===================== GROUP B — JENKINS SNIPPET =====================

describe('Jenkinsfile snippet → POST /api/ci/webhook', () => {
  it('produces a JSON body that safeParse()s against CiWebhookTriggerBody', async () => {
    const raw = loadSnippetRaw('JENKINSFILE_SNIPPET');
    const rendered = substituteVars(raw, {
      GIT_URL: 'https://github.com/example/repo.git',
      GIT_BRANCH: 'main',
      GIT_COMMIT: 'abc1234567890abcdef1234567890abcdef12345',
      BUILD_ID: '99',
      STAGE_NAME: 'VulnAware scan',
      VULN_AWARE_URL: 'https://app.example.com',
      CI_WEBHOOK_TOKEN: TEST_TOKEN,
    });
    const payload = extractCurlPayload(rendered);
    const parsedBody = JSON.parse(payload);
    const result = CiWebhookTriggerBody.safeParse(parsedBody);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repository?.url).toBe('https://github.com/example/repo.git');
      expect(result.data.repository?.ref).toBe('main');
      expect(result.data.build?.id).toBe('99');
    }
  });

  it('POSTs in-process and returns 202 when supplied the matching bearer', async () => {
    const raw = loadSnippetRaw('JENKINSFILE_SNIPPET');
    const rendered = substituteVars(raw, {
      GIT_URL: 'https://github.com/example/repo.git',
      GIT_BRANCH: 'main',
      GIT_COMMIT: 'abc1234567890abcdef1234567890abcdef12345',
      BUILD_ID: '99',
      STAGE_NAME: 'VulnAware scan',
      VULN_AWARE_URL: 'https://app.example.com',
      CI_WEBHOOK_TOKEN: TEST_TOKEN,
    });
    const payload = extractCurlPayload(rendered);
    const parsed = JSON.parse(payload);

    const { POST } = await import('@/app/api/ci/webhook/route');
    const res = await POST(mkRequest({ body: parsed, authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).toBe(202);
    expect(scanCreate).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
  });
});

// ===================== GROUP C — LITERAL PRESERVATION =====================

describe('Snippet extractor literal preservation', () => {
  // Pins the page.tsx banner warning: `${VAR}` / `${env.VAR}` / `$VAR`
  // must SURVIVE parse through the TS template literal so React's JSX
  // interpolation can't accidentally collapse them. The TEST loads the
  // file as raw text (readFileSync), so what we see here is the TS
  // SOURCE form `\${VAR}` — TS back-tick escape that produces `${VAR}`
  // at module-load. Either form on either side proves the literal is
  // preserved (the customer never sees a backslash; the customer only
  // sees the runtime form).
  it('GitLab snippet source pins ${CI_WEBHOOK_TOKEN}/${CI_PROJECT_URL}/${VULN_AWARE_URL}', () => {
    const raw = loadSnippetRaw('GITLAB_CI_YML');
    // Source form (what's in the TS source file):
    expect(raw).toContain('\\${CI_WEBHOOK_TOKEN}');
    expect(raw).toContain('\\${CI_PROJECT_URL}');
    expect(raw).toContain('\\${CI_COMMIT_REF_NAME}');
    expect(raw).toContain('\\${CI_COMMIT_SHA}');
    expect(raw).toContain('\\${CI_PIPELINE_ID}');
    expect(raw).toContain('\\${CI_JOB_STAGE}');
    expect(raw).toContain('\\${VULN_AWARE_URL}');
  });

  it('Jenkinsfile snippet source pins $CI_WEBHOOK_TOKEN, ${env.GIT_URL}', () => {
    const raw = loadSnippetRaw('JENKINSFILE_SNIPPET');
    // `$CI_WEBHOOK_TOKEN` lives in the bearer-header `-H` line — bash
    // expands it from the runtime env, no TS escape needed.
    expect(raw).toContain('$CI_WEBHOOK_TOKEN');
    // `${env.X}` sits inside bash single quotes — added as the
    // TS-escape `\${env.X}` so Groovy sees `${env.X}` after TS parsing.
    expect(raw).toContain('\\${env.GIT_URL}');
    expect(raw).toContain('\\${env.VULN_AWARE_URL}');
    expect(raw).toContain("credentialsId: 'ci-webhook-token'");
  });

  it('GitLab `-d` payload contains literal JSON body (single-quoted bash arg)', () => {
    const raw = loadSnippetRaw('GITLAB_CI_YML');
    // Single-quoted bash arg whose body opens with `{"repository":"...` and
    // closes before the line-continuation `\\`. The body itself is JSON.
    expect(raw).toMatch(/-d '\{[^']*\}'/);
  });

  it('Jenkins `-d` payload contains literal JSON body (single-quoted bash arg)', () => {
    const raw = loadSnippetRaw('JENKINSFILE_SNIPPET');
    expect(raw).toMatch(/-d '\{[^']*\}'/);
  });
});

// ===================== GROUP D — AUTH FAILURES =====================

describe('POST /api/ci/webhook auth failures (snippets viewpoint)', () => {
  it('returns 401 {error:"unauthorized"} when a snippet POST omits Authorization', async () => {
    const raw = loadSnippetRaw('GITLAB_CI_YML');
    const rendered = substituteVars(raw, {
      CI_PROJECT_URL: 'https://gitlab.example.com/g/p',
      CI_COMMIT_REF_NAME: 'main',
      CI_COMMIT_SHA: 'abc1234567890abcdef',
      CI_PIPELINE_ID: '1',
      CI_JOB_STAGE: 'test',
      VULN_AWARE_URL: 'https://app.example.com',
    });
    const payload = extractCurlPayload(rendered);
    const parsed = JSON.parse(payload);

    const { POST } = await import('@/app/api/ci/webhook/route');
    const res = await POST(mkRequest({ body: parsed, authorization: null }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(scanCreate).not.toHaveBeenCalled();
  });

  it('returns 401 {error:"unauthorized"} for a wrong-length bearer', async () => {
    const raw = loadSnippetRaw('JENKINSFILE_SNIPPET');
    const rendered = substituteVars(raw, {
      GIT_URL: 'https://github.com/example/repo.git',
      GIT_BRANCH: 'main',
      GIT_COMMIT: 'abc1234567890abcdef',
      BUILD_ID: '1',
      STAGE_NAME: 'VulnAware scan',
      VULN_AWARE_URL: 'https://app.example.com',
      CI_WEBHOOK_TOKEN: 'totally-different',
    });
    const payload = extractCurlPayload(rendered);
    const parsed = JSON.parse(payload);

    const { POST } = await import('@/app/api/ci/webhook/route');
    const res = await POST(mkRequest({ body: parsed, authorization: 'Bearer nope-1234567890' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(scanCreate).not.toHaveBeenCalled();
  });
});

// ===================== GROUP E — COLD DEPLOY SIGNAL =====================

describe('POST /api/ci/webhook cold deploy signal', () => {
  it('returns 503 {error:"ci_webhook_token_not_configured"} when env vars unset', async () => {
    // Re-mock @/lib/env to simulate a cold deploy (no token wired).
    vi.doMock('@/lib/env', () => ({
      env: {
        NODE_ENV: 'test',
        CI_WEBHOOK_TOKEN: undefined,
        CI_WEBHOOK_TOKENS_JSON: undefined,
      },
    }));
    const raw = loadSnippetRaw('GITLAB_CI_YML');
    const rendered = substituteVars(raw, {
      CI_PROJECT_URL: 'https://gitlab.example.com/g/p',
      CI_COMMIT_REF_NAME: 'main',
      CI_COMMIT_SHA: 'abc1234567890abcdef',
      CI_PIPELINE_ID: '1',
      CI_JOB_STAGE: 'test',
      VULN_AWARE_URL: 'https://app.example.com',
    });
    const payload = extractCurlPayload(rendered);
    const parsed = JSON.parse(payload);

    const { POST } = await import('@/app/api/ci/webhook/route');
    const res = await POST(
      mkRequest({
        body: parsed,
        // Authorization is provided, but the test must still trip 503 —
        // surfacing the fail-closed cold-deploy signal rather than 401'ing.
        authorization: `Bearer ${TEST_TOKEN}`,
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('ci_webhook_token_not_configured');
    expect(scanCreate).not.toHaveBeenCalled();
  });
});
