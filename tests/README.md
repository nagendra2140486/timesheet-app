# End-to-end suite

Playwright journeys for the four things this app does: signing in, managing clients, logging work
entries, and reporting. This is also the suite PRQE's functional stage runs (`functional.runner:
playwright` in `devin/config.yaml`), so it doubles as the deployment check.

```
e2e/auth.spec.ts           login, session, access control   ← mandatory: runs on every PR
e2e/clients.spec.ts        client CRUD through the dialog
e2e/work-entries.spec.ts   logging, correcting and deleting hours
e2e/reports.spec.ts        dashboard totals, per-client report, CSV export
e2e/fixtures.ts            per-test tenant + coverage observation
e2e/helpers.ts             API setup for data a journey needs but does not assert
spec-inventory.json        generated: the closed list of test titles selection may choose from
coverage-map.json          generated: what each test actually executed at run time
```

## Running

```bash
npm ci
npx playwright install chromium
npx playwright test
```

With nothing set it targets `http://localhost:5173` and `http://localhost:3001`. Point it at a
deployment with two variables, which is exactly what PRQE passes from the CRaaS trigger payload:

```bash
TIMESHEET_BASE_URL=https://example.net TIMESHEET_API_URL=https://example.net npx playwright test
```

## Two things to know before running against a shared environment

**Tests are safe to run against real data, by construction.** Every row in this app is scoped to
`user_email`, so each test invents its own address (`uniqueEmail()`) and works in a private tenant.
Nothing seeds, truncates or shares state — which is also why the suite is parallel-safe and needs no
cleanup.

**Raise the rate limit on the target.** The backend allows 100 requests per IP per 15 minutes; a
full run makes several hundred from one address and starts collecting `429`s around test 20, which
look like failures. Start the target with `RATE_LIMIT_MAX` raised (`devin/config.yaml` records this
under `functional.target_env`).

## Regenerating the two JSON files

Impact analysis reads both. Neither is hand-edited, and both go stale silently.

```bash
npm run inventory      # after adding, renaming or removing a test
npm run coverage:map   # after changing what a test touches; needs a running stack
```

- **`spec-inventory.json`** comes from `playwright test --list`, so it needs no services. It is the
  vocabulary test selection is allowed to choose from: a title that is not in it cannot be selected.
  `npm run inventory:check` fails when it is stale, which is what CI should run.
- **`coverage-map.json`** is recorded by `reporters/coverage-map.ts` during an instrumented run
  (`TIMESHEET_COVERAGE=1`, single worker). For every test it stores the app routes visited, the API
  endpoints called and the **frontend source files whose functions actually executed**, taken from
  V8 coverage rather than from test names — so it stays correct when tests are refactored, and a
  change to `ReportsPage.tsx` selects the tests that really render it. It also parses the router
  mounts in `backend/src/server.js` so a backend file resolves to the endpoints it serves.

A stale map does not fail loudly; it quietly selects the wrong tests. Regenerate it in the same
change that alters a journey.
