# Workspace schema integration check

## Asset hostname search

The focused unit coverage checks URL-persisted hostname search, list-parameter
preservation, active-workspace predicates, case-insensitive host matching, CSV
scope, and filtered versus unfiltered empty states:

```sh
node --env-file=.env --env-file=.env.test ./node_modules/vitest/vitest.mjs run \
  tests/unit/assets-hostname-search.test.tsx tests/unit/api/assets-route.test.ts
```

The maintained browser journey for this feature uses synthetic workspaces and
asset/alert fixtures in the disposable database. Fixtures must be removed in
the test cleanup and must never be copied into committed code or documentation.

```sh
BASE_URL=http://127.0.0.1:3000 npm run test:e2e -- \
  tests/e2e/assets-hostname-search.spec.ts
```

The workspace integration check uses the disposable PostgreSQL database supplied
to the sandbox. `.env.test` contains synthetic auth/app settings only; the
database URL is injected by the sandbox and must not be copied into a committed
fixture. Apply the current Prisma schema, then run:

```sh
npx prisma db push
node --env-file=.env --env-file=.env.test --conditions=react-server --import tsx tests/integration/workspaces.test.ts
```

The script creates uniquely named synthetic Teams, memberships, workspaces, and
roster rows, then removes them in a `finally` block. It checks the Team-to-
Workspace ID backfill, owner selection, seed idempotency, default member role,
pending invitations, and one user's memberships in multiple workspaces. Do not
point it at a production database or copy a database URL into a committed file.

`WorkspaceMember` is already populated. The schema-only deploy path cannot add a
new unique `(workspaceId, userId)` key in this change, so that pair has a lookup
index; the existing `(workspaceId, email)` uniqueness remains in force. Enforcing
per-workspace user uniqueness needs a staged migration path with deduplication.

## Signup workspace coverage

The new signup checks exercise the existing Better Auth API and `/signup` page.
They use synthetic `example.invalid` accounts and remove their auth, trial,
team, workspace, and roster rows during cleanup.

For the PostgreSQL integration check, start the app with the disposable database
and synthetic test settings available, then run:

```sh
npx prisma db push
set -a
. ./.env.test
set +a
npm run dev -- --hostname 127.0.0.1
BASE_URL=http://127.0.0.1:3000 npm run test:integration:signup-workspace
```

The integration check submits a real Better Auth signup, confirms duplicate
signup and sign-in behavior, provisions concurrently, verifies rollback and
repair, and exercises both trial signup endpoints including duplicate retries.
The API server must remain running while the integration script executes.

Run the maintained signup browser check with Chromium installed:

```sh
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
npm run test:e2e
```

## Active workspace API journey

`tests/e2e/active-workspace.spec.ts` signs up a synthetic `example.invalid`
account through the real `/signup` flow, creates one active-member workspace
and one inaccessible workspace in the disposable test database, and exercises
the authenticated `POST`/`GET /api/workspace/active` routes in the browser.
It checks that denied selections preserve the current cookie, stale cookies
fall back to the signup-owned workspace, and selecting a workspace does not
change workspace or roster rows. The `afterAll` cleanup removes its auth,
subscription, digest, team, workspace, trial and roster fixtures.

Run it with the local Next.js server and synthetic environment available:

```sh
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
npm run test:e2e -- --grep "selects an active member workspace"
```

The Playwright config starts a local Next.js dev server when `BASE_URL` is not
set. Set `BASE_URL` to an already-running test app when running against the
shared verification server.

## Dashboard active-workspace isolation

`tests/e2e/dashboard-active-workspace.spec.ts` signs up a synthetic account,
creates two populated member workspaces, a zero-data workspace, and an
inaccessible workspace. The populated fixtures include distinct scan, asset,
finding, open, snoozed, resolved, and remediated rows. The browser checks all
eleven dashboard overview APIs against each accessible workspace, verifies the
existing empty-state copy, and confirms denied selection preserves the active
workspace. It also opens the dashboard workspace menu, verifies the inaccessible
workspace is absent, switches between member workspaces from the UI, checks the
current route and dashboard API output, then reloads and verifies the selected
workspace remains visible. Anonymous overview reads still return 401. Its
`afterAll` cleanup removes the synthetic auth, workspace, membership, alert,
scan, asset, and finding records.

Run it with the disposable database, synthetic test environment, and local app
server available:

```sh
npx prisma db push
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
set -a
. ./.env.test
set +a
npm run dev -- --hostname 127.0.0.1 --port 3000
BASE_URL=http://127.0.0.1:3000 npm run test:e2e -- --grep "alert detail follows the active workspace"
```

The Playwright config starts the local Next.js server automatically when
`BASE_URL` is unset. The test uses only synthetic `example.invalid` accounts and
never copies database credentials into its fixture.

## Alerts active-workspace isolation

The `/alerts` list, asset-option facets, and CSV export resolve the authenticated
user's validated active workspace. Alert rows keep their existing `teamId`
column, which aliases the workspace ID; no fallback to the auth context's
default team is used. `ownedByMe=1` uses the active workspace roster row, and
returns no owned rows when that roster row is unavailable. The list's totals,
severity and snoozed badges, trend marker, and owner-name lookup stay within the
same workspace.

`GET /api/alerts/[id]` applies the active-workspace rule before loading an
alert or its related CVE and asset data. A user needs an active
`WorkspaceMember` row in the selected workspace; a global admin role and an
owner-only context do not replace that membership. Missing, cross-workspace,
owner-only, and no-context requests return the same opaque 404. Anonymous API
requests return 401. The detail page uses generic branded noindex metadata so
unauthenticated page requests do not expose alert-specific fields.

`POST /api/alerts/[id]/resolve` uses the same selected-workspace and active
`WorkspaceMember` context as the detail GET. The browser journey opens an
unresolved alert in the authorized workspace, submits an optional closing note
through the real dialog, verifies the visible `Resolved` badge and hidden resolve
CTA, then checks the response and Prisma row for the resolved status, close stamp,
actor, and note. With the other accessible workspace selected, the same POST is
an opaque 404 and does not mutate or reveal the alert; an anonymous POST returns
401. The synthetic fixture therefore needs two accessible workspaces, an open
alert in the selected workspace, and distinct alert identifiers/details per
workspace.

The focused route tests cover active-workspace predicates, combined
`severity=critical&status=open&ownedByMe=1` filters, and
`status=resolved&severity=high&ownedByMe=1`. The resolved filter composes with
severity and the active roster owner while the handler takes workspace scope
from the validated active-workspace context and ignores a URL-supplied
`teamId`; unknown status values return 400.
The tests also cover detail membership and workspace scope (including
admin-without-membership and owner-only denial), a missing workspace context,
a workspace with no active roster row, and the asset-option response. CSV export goes through the installed `csv-export`
adapter at `POST /api/alerts/export.csv`; the adapter resolves the session's
active workspace and `WorkspaceMember` row on the server, accepts the same
list filters, and exposes only `finding_title`, `asset_host`, `severity`,
`status`, `cve_id`, `opened_at`, `last_activity_at`, and `snoozed_until`.
The adapter uses the module's required lowercase snake-case keys for the same
eight fields and order. The export adds its `polsia-csv-v2` metadata columns
and applies the 10,000-record,
10 MiB UTF-8, and 16,384-character cell limits. A request over a limit fails
with the module's 413 response; it is never silently truncated. An empty
result uses the module's 422 no-results response.

The browser journey above uses the existing synthetic signup flow and two
ID-aligned Team/Workspace fixtures. Each workspace gets its own active roster
ID and uniquely named member-owned alerts. The second workspace includes a
resolved high alert and an open high alert; the first workspace has a separate
resolved high alert. With the second workspace selected, the `status=resolved`
chip composes with `severity=high&ownedByMe=1`, and both the API response and
rendered `/alerts` page contain only the second workspace's resolved row. The
journey reloads the URL to verify chip restoration, clears Resolved while
retaining severity and owner filters, checks a no-match result, and clicks the
chip at a narrow viewport after the severity row wraps. Fifty extra matching alerts make the second
workspace result span two list pages. The test selects both workspaces, applies
combined filters, compares the CSV rows with both list pages, clicks the actual
`/alerts` download control, and checks the downloaded CSV's allowed header and
workspace rows. Anonymous export returns 401; a client-supplied workspace ID
is rejected, and rows from the other workspace never appear in the file.

Run the focused Resolved-chip and URL-state unit checks with:

```sh
node --env-file=.env --env-file=.env.test ./node_modules/vitest/vitest.mjs run tests/unit/alerts-status-chip-row.test.tsx tests/unit/alerts-resolved-chip-row.test.tsx tests/unit/alerts-effective-qs.test.ts tests/unit/api/alerts-route.test.ts
```

The authenticated browser journey's focused Playwright command later in this
section also exercises selecting, reloading, and clearing the Resolved chip.

Run only the resolve route unit suite with:

```sh
node --env-file=.env --env-file=.env.test ./node_modules/vitest/vitest.mjs run tests/unit/api/alerts-resolve-route.test.ts
```

Run the route and source-contract checks with:

```sh
node --env-file=.env --env-file=.env.test ./node_modules/vitest/vitest.mjs run tests/unit/api/alerts-detail-route.test.ts tests/unit/api/alerts-resolve-route.test.ts tests/unit/api/alerts-route.test.ts tests/unit/api/alerts-owned-by-route.test.ts tests/unit/api/alerts-owned-by-composition.test.ts tests/unit/api/alerts-asset-options-route.test.ts tests/unit/api/alerts-list-search-by-q.test.ts tests/unit/api/alerts-since-composition.test.ts tests/unit/api/alerts-since-route.test.ts
```

The repository's default Vitest config includes `tests/unit/**` only. Run the
CSV adapter and module-limit contract checks separately with their opt-in config:

```sh
node --env-file=.env --env-file=.env.test ./node_modules/vitest/vitest.mjs run --config tests/integration/vitest.config.ts tests/integration/alerts-export.test.ts
```

Run the authenticated browser journey with the disposable PostgreSQL database,
synthetic test environment, and a local app server available:

```sh
npx prisma db push
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
set -a
. ./.env.test
set +a
npm run dev -- --hostname 127.0.0.1 --port 3000
```

In another terminal, run:

```sh
BASE_URL=http://127.0.0.1:3000 npm run test:e2e -- --grep "alert detail follows the active workspace"
```

The synthetic browser fixture creates only `example.invalid` auth, workspace,
alert, scan, asset, finding, and one CVE description record. It checks the
authorized detail response and page, the cross-workspace 404, the anonymous
detail and export 401 responses, generic anonymous page metadata, and that
detail reads leave the alert row unchanged. Cleanup removes these fixtures
from the disposable database.

## Password reset journey

`tests/e2e/password-reset.spec.ts` creates one synthetic user through the real
signup page, follows the sign-in page's “Forgot password?” link, and compares the
Better Auth responses and public confirmation for a known and an unknown
address. Its test-only HTTP mail-proxy stub listens on `127.0.0.1:4319`; the
ignored `.env.test` points the app's Email helper at that stub. The spec captures
the reset email, follows its Better Auth callback URL, changes the password,
checks that the old password no longer works, and verifies the reset token was
consumed. Later requests make the stub return an HTTP failure and a successful
suppression response, then confirm both remain account-neutral. The spec also
checks missing, invalid, and expired reset tokens and removes its synthetic auth
and workspace rows afterward.

Use the sandbox's disposable PostgreSQL database. Keep its `DATABASE_URL` in the
ignored `.env`, not `.env.test`; `.env.test` contains only synthetic auth/app
settings and the local stub URL. Start the app with those settings loaded, then
run the focused browser journey:

```sh
npx prisma db push
set -a
. ./.env.test
set +a
npm run dev -- --hostname 127.0.0.1 --port 3000
```

In a second terminal:

```sh
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
npm run test:e2e -- --grep "password reset"
```

## Asset risk-score history

`tests/unit/assets-risk-trend.test.ts` verifies that persisted
`VulnerabilityFinding.priorityScore` values are grouped by scan, reduced to the
maximum scored finding per host and scan, filtered to `Scan.startedAt` in the
trailing 30-day window, and returned oldest first. The protected route coverage
is in `tests/unit/api/assets-risk-trend-route.test.ts`; it checks authentication,
normalized host and active-team scope, invalid paths, the dated response shape,
empty history, and query failures.

Run the focused unit checks with the repository's test environment:

```sh
node --env-file=.env --env-file=.env.test ./node_modules/vitest/vitest.mjs run tests/unit/assets-risk-trend.test.ts tests/unit/api/assets-risk-trend-route.test.ts
```

The database-backed browser journey in `tests/e2e/assets-risk-history.spec.ts`
signs up a synthetic `example.invalid` user, creates active-team scans with
multiple scores per scan, null scores, out-of-window rows, another host, and a
separate team. It visits the asset detail at desktop and narrow widths, checks
that the 30-day context is visible, the SVG path plots distinct score levels,
chronological timestamps, and the API response, then verifies a host with no
scored scans renders the 30-day empty state. It also confirms the sparkline and
points remain visible at the narrow viewport. The test deletes its alerts,
scans, fixtures, extra team, and synthetic auth/workspace rows in `afterAll`.

Run it against the disposable PostgreSQL database and a local app server:

```sh
npx prisma db push
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
set -a
. ./.env.test
set +a
npm run dev -- --hostname 127.0.0.1 --port 3000
```

In another terminal, run:

```sh
BASE_URL=http://127.0.0.1:3000 npm run test:e2e -- --grep "asset detail renders dated scan risk scores"
```

The shared verification helper also runs the maintained unit suite, build, and
lint checks. E2E verification requires the disposable database and Chromium
runtime described above; do not use a production database or commit database
credentials.

The Playwright spec starts and stops its local mail-proxy stub itself. Run the
unit checks with:

```sh
npm run test -- tests/unit/auth/password-reset-request-form.test.tsx tests/unit/email/password-reset-template.test.ts
```

## Public product changelog

The public changelog uses static fixtures in `src/lib/content/changelog.ts`;
its API and browser journey need no database rows or signed-in account. Run
the focused unit and browser checks with:

```sh
npm run test -- tests/unit/changelog.test.ts tests/unit/api/changelog-route.test.ts tests/unit/changelog-list.test.tsx
npm run test:e2e -- --grep "public changelog"
```
