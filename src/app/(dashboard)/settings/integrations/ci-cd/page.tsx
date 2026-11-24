// @polsia:user-owned — Manager page for CI/CD integrations. Server
// Component; exports metadata for the page-level SEO. Composes the client
// island that actually fetches the data. NO `await prisma`, `@/lib/db`, or
// any fetch in this file — every read goes through the island's apiFetch.
//
// Admin gating is enforced server-side at GET /api/v1/webhooks/triggers
// (returns 401/403 JSON), matching the api-keys page posture. Non-admin
// visitors see this page rendered (SEO reads correctly) but the island
// surfaces a role-alert error from apiFetch rather than triggering a
// redirect. The nav link is requiresAuth: true so anon visitors never
// reach this surface anyway.
//
// The "Wire it up" section renders code snippets as plain STRING children
// (not React template literals) so GitHub Actions / GitLab CI / Jenkins
// template expressions like `${{ github.ref }}`, `${CI_PROJECT_URL}` and
// `${env.GIT_URL}` survive copy-paste. Each snippet is a TS backtick-
// literal constant whose source contains literal `$` / `${...}`; the
// constant is passed straight to <code>{CONSTANT}</code> AS a string
// child so React never tries to interpolate it.

import type { Metadata } from 'next';
import { SnippetCopyButton } from '@/components/custom/ci-cd/snippet-copy-button';
import { CicdTriggerList } from '@/components/custom/ci-cd/trigger-list';
import { brand } from '@/lib/brand';

const GITHUB_ACTIONS_YAML = `name: vulnaware-scan
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger VulnAware scan
        env:
          CI_WEBHOOK_TOKEN: \${{ secrets.CI_WEBHOOK_TOKEN }}
        run: |
          curl -fsS -X POST \\
            -H "Authorization: Bearer $CI_WEBHOOK_TOKEN" \\
            -H 'Content-Type: application/json' \\
            -d '{"repository":{"url":"https://github.com/\${{ github.repository }}","ref":"\${{ github.ref }}","commit":"\${{ github.sha }}"},"build":{"id":"\${{ github.run_id }}","status":"\${{ github.event_name }}","branch":"\${{ github.ref_name }}"}}' \\
            '\${{ vars.VULN_AWARE_URL }}/api/ci/webhook'`;

// GitLab CI snippet. gitlab-runner resolves BOTH `${VAR}` and `$VAR`
// BEFORE bash sees the script, so every token lands baked into the wire
// payload (bash's single-quoted `-d '…'` arg preserves those baked
// values verbatim — no further `$VAR` expansion pass inside the JSON).
// TS-side: we escape every `${VAR}` with `\` so the `\${VAR}` reaches
// gitlab-runner as `${VAR}`. The operator must mark `CI_WEBHOOK_TOKEN`
// as Protected + Masked at the project's Settings → CI/CD → Variables
// page so the secret never leaks into CI job logs.
const GITLAB_CI_YML = `stages:
  - test

vulnaware-scan:
  stage: test
  script:
    - |
      curl -fsS -X POST \\
        -H "Authorization: Bearer \${CI_WEBHOOK_TOKEN}" \\
        -H "Content-Type: application/json" \\
        -d '{"repository":{"url":"\${CI_PROJECT_URL}","ref":"\${CI_COMMIT_REF_NAME}","commit":"\${CI_COMMIT_SHA}"},"build":{"id":"\${CI_PIPELINE_ID}","status":"\${CI_JOB_STAGE}","branch":"\${CI_COMMIT_REF_NAME}"}}' \\
        "\${VULN_AWARE_URL}/api/ci/webhook"`;

// Jenkinsfile snippet. Groovy `sh '''…'''` single-quoted block keeps
// `${env.X}` LITERAL through Groovy's interpolation pass, so each
// `${env.X}` reference survives into bash unchanged. Bash then expands
// them from the pipeline's own env at exec time. TS-side: we escape
// every `${env.X}` with `\` so the `\${env.X}` reaches Groovy as
// `${env.X}`. `withCredentials` injects `CI_WEBHOOK_TOKEN` into bash's
// env so the `$CI_WEBHOOK_TOKEN` expansion resolves to the masked
// secret at exec time — it never sits in static Jenkinsfile source.
// The credential MUST be added under the `Secret text` kind with id
// `ci-webhook-token`.
const JENKINSFILE_SNIPPET = `pipeline {
  agent any
  stages {
    stage('VulnAware scan') {
      steps {
        withCredentials([string(credentialsId: 'ci-webhook-token', variable: 'CI_WEBHOOK_TOKEN')]) {
          sh '''
            curl -fsS -X POST \\
              -H "Authorization: Bearer $CI_WEBHOOK_TOKEN" \\
              -H "Content-Type: application/json" \\
              -d '{"repository":{"url":"\${env.GIT_URL}","ref":"\${env.GIT_BRANCH}","commit":"\${env.GIT_COMMIT}"},"build":{"id":"\${env.BUILD_ID}","status":"\${env.STAGE_NAME}","branch":"\${env.GIT_BRANCH}"}}' \\
              "\${env.VULN_AWARE_URL}/api/ci/webhook"
          '''
        }
      }
    }
  }
}`;

const CURL_SNIPPET = `curl -fsS -X POST \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"target":"example.com","ports":[443]}' \\
  https://YOUR-HOST/api/ci/webhook`;

export const metadata: Metadata = {
  title: `CI/CD integrations — ${brand.name}`,
  description:
    'Wire a CI job to the bearer-token /api/ci/webhook endpoint, and review recent HMAC-gated webhook trigger deliveries for CI/CD pipelines.',
};

export default function CicdIntegrationsPage() {
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <p className="text-caption uppercase tracking-wide text-muted-foreground">Settings</p>
        <h1 className="text-h2 text-foreground">CI/CD integrations</h1>
        <p className="max-w-prose text-body text-muted-foreground">
          Wire a CI job to the bearer-token <code>/api/ci/webhook</code> endpoint and review recent
          HMAC-gated webhook trigger deliveries. Each CI-driven scan lands on the Scans page tagged{' '}
          <code>source=&apos;ci-webhook&apos;</code> and surfaces in the <code>Triggered by</code>{' '}
          chip on the Alerts page.
        </p>
      </header>

      <section className="grid gap-4">
        <h2 className="text-h3 text-foreground">Recent triggers</h2>
        <CicdTriggerList />
      </section>

      <section className="grid gap-4">
        <h2 className="text-h3 text-foreground">Wire it up</h2>
        <p className="max-w-prose text-body text-muted-foreground">
          The endpoint accepts a single-factor bearer token configured in your deploy — either{' '}
          <code>CI_WEBHOOK_TOKEN</code> for a single-workspace deployment or{' '}
          <code>CI_WEBHOOK_TOKENS_JSON</code> for multi-workspace. Env values are injected at deploy
          time by the platform and are never echoed in source.
        </p>
        <p className="max-w-prose text-caption text-muted-foreground">
          Set <code>CI_WEBHOOK_TOKEN</code> (or the per-team <code>CI_WEBHOOK_TOKENS_JSON</code>{' '}
          map) as a repository environment secret. If you rotate, the previous token is rejected
          immediately.
        </p>

        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <p className="text-caption uppercase tracking-wide text-muted-foreground">
              GitHub Actions
            </p>
            <SnippetCopyButton value={GITHUB_ACTIONS_YAML} label="GitHub Actions YAML" />
          </div>
          <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-card p-4 font-mono text-caption text-foreground shadow-md">
            <code>{GITHUB_ACTIONS_YAML}</code>
          </pre>
        </div>

        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <p className="text-caption uppercase tracking-wide text-muted-foreground">GitLab CI</p>
            <SnippetCopyButton value={GITLAB_CI_YML} label="GitLab CI YAML" />
          </div>
          <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-card p-4 font-mono text-caption text-foreground shadow-md">
            <code>{GITLAB_CI_YML}</code>
          </pre>
          <p className="max-w-prose text-caption text-muted-foreground">
            Set <code>CI_WEBHOOK_TOKEN</code> as a GitLab CI/CD variable (Protected + Masked) at
            Settings → CI/CD → Variables, then reference it as <code>$CI_WEBHOOK_TOKEN</code> in
            your <code>.gitlab-ci.yml</code>.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <p className="text-caption uppercase tracking-wide text-muted-foreground">Jenkins</p>
            <SnippetCopyButton value={JENKINSFILE_SNIPPET} label="Jenkinsfile snippet" />
          </div>
          <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-card p-4 font-mono text-caption text-foreground shadow-md">
            <code>{JENKINSFILE_SNIPPET}</code>
          </pre>
          <p className="max-w-prose text-caption text-muted-foreground">
            Add a Jenkins credential of kind <code>Secret text</code> with id{' '}
            <code>ci-webhook-token</code>, then reference it via{' '}
            <code>
              withCredentials([string(credentialsId: &apos;ci-webhook-token&apos;, variable:
              &apos;CI_WEBHOOK_TOKEN&apos;)])
            </code>{' '}
            inside your pipeline.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <p className="text-caption uppercase tracking-wide text-muted-foreground">curl</p>
            <SnippetCopyButton value={CURL_SNIPPET} label="curl command" />
          </div>
          <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-card p-4 font-mono text-caption text-foreground shadow-md">
            <code>{CURL_SNIPPET}</code>
          </pre>
        </div>
      </section>
    </div>
  );
}
