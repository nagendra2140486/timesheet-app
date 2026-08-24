# PRQE — continuous remediation and validation

CRaaS raises vulnerability tickets, a fixing agent commits remediations, the code is deployed, and
this chain then answers one question: **did the fixes work, and did they break anything?**

Six playbooks are shared by every repository. They contain no repository paths, no test commands
and no report names. Everything repo-specific is declared here, in `devin/`. That is the whole
design: onboard a repository by describing it, not by editing playbooks.

```
devin/
  config.yaml       what the playbooks read: paths, commands, rails, report types
  tools/            stdlib-only Python, no dependencies to install
    heartbeat.py                 post-deploy availability gate
    heartbeat-expectations.json  this repo's expected data — edited per repo
    publish_report.py            POSTs a report to the CRaaS API
    agent_log.py                 POSTs one run-stats row per stage
    tickets.py                   ticket -> commits -> changed files
  playbooks/        the stage playbooks
  README.md         this file
```

Most of `playbooks/` is **mirrors**: the live copies of the orchestrator, PR analysis, functional
and performance playbooks are stored in Devin, and editing those files here changes nothing about
a run. The two exceptions are `p2-heartbeat.md` and `p5-final-analysis.md`, which the orchestrator
reads from the clone and executes in its own session — for those, this copy is what runs, and the
Devin copy is kept in step only for the case where the stage is dispatched as a child.

---

# Part 1 — For repository owners: onboarding a repo

Six steps. Steps 1–3 take minutes; step 4 is the real work and is what determines whether ticket
attribution and test selection are worth anything.

## Step 1 — Copy the folder

Copy `devin/` from a repo that already has it. Then work through `config.yaml` top to bottom and
make every value true for your repo.

Declare a capability as `null` when the repo does not have it:

```yaml
performance:
  runner: null          # this repo has no load test
```

The stage then reports itself unavailable **with that reason** instead of improvising a command
that does not exist. A missing capability is a fact to report, not an error to hide.

## Step 2 — Rewrite the heartbeat expectations

`tools/heartbeat-expectations.json` is the entire port. Every check is data in that file, not code
in `heartbeat.py`: services and health paths, the API surface, seed baselines, config assertions,
the CORS probe.

**A copied file asserts the wrong things and still exits 0** — voyagenie's expects 12 destinations
and 8 packages, which timesheet-app does not have and never will.

Two ways to declare the API surface:

```jsonc
// voyagenie: enumerate GET endpoints from the OpenAPI document, so the gate
// follows the API automatically. Removing a route removed a check, with no edit.
{ "openapi": { "path": "/api/openapi.json", "expect_status": 200 } }

// timesheet-app: an explicit list, because there is no spec document.
{ "endpoints": [
    { "method": "GET",  "path": "/api/clients", "expect_status": 401 },
    { "method": "POST", "path": "/api/auth/login",
      "json_body": { "email": "not-an-email" }, "expect_status": 400 }
] }
```

**Watch for probes that write data.** timesheet-app's `POST /api/auth/login` *creates* the user
when it does not exist, and `authenticateUser` inserts on an unknown `x-user-email`. A naive
liveness check would write application rows before the suites run. Its checks therefore probe
anonymously (expect `401`) and send an invalid email so Joi rejects it (`400`) — the auth surface
is exercised, nothing is inserted. Check your repo for the same trap.

## Step 3 — Adopt the commit convention

Ticket attribution reads **commit titles and bodies only** — never the PR title or the branch
name, because one ticket per PR is exactly what per-ticket attribution exists to avoid.

```
fix(security): VIT0016042 - remove unauthenticated contact inquiry listing
```

The pattern is `\bVIT\d{5,}\b` anywhere in the title or body. Both of these work:

```
fix(VIT0015739): security remediation
fix(security): VIT0016042 - remove unauthenticated contact inquiry listing
```

Commits with no id are collected under `_untracked`, and their failures are reported as
non-ticket-related rather than attached to the nearest ticket.

> This convention is a real prerequisite, not a nicety. timesheet-app PR #172 has two commits both
> titled `fix(security): remediate all findings`, with `VIT0015739` only in the PR title and
> branch name. That PR cannot be attributed per ticket. If your fixing agent produces commits like
> that, fix the agent before relying on the ticket table.

Verify before the first run:

```bash
python3 devin/tools/tickets.py --repo . --base <merge-base> --head <head> --out tickets.json
```

Every remediation commit should appear under a ticket, and `_untracked` should be empty or
deliberate.

## Step 4 — Build the selection inputs (the long pole)

Two files drive test selection and failure attribution. Without them the chain still runs, but it
falls back to path conventions and reports lower confidence.

| File | What it is | Config key |
| --- | --- | --- |
| `spec-inventory.json` | the closed vocabulary of tests that exist | `impact.spec_inventory` |
| `coverage-map.json` | recorded evidence of what each test actually exercised | `impact.coverage_map` |

**There is no playbook for generating these.** They are produced by repo-local scripts, which each
repo must provide. Voyagenie's are the reference implementation:

```bash
cd tests
npm run inventory      # scripts/generate-inventory.mjs -> spec-inventory.json
npm run coverage:map   # VOYAGENIE_COVERAGE=1 playwright test -> coverage-map.json
```

**`spec-inventory.json`** comes from `playwright test --list`, so it needs no running services. It
exists so a selection can be validated before anything runs: a selected test that is not in the
inventory means the inventory moved or the selection is wrong, and the stage falls back to the
full suite rather than quietly testing less than it claims.

**`coverage-map.json`** is recorded during an instrumented run (`tests/e2e/fixtures.ts` plus the
`tests/reporters/coverage-map.ts` reporter). For every test it records, at runtime:

- the app routes it visited,
- the API endpoints it called — normalised, so `/api/packages?style=luxury` becomes
  `GET /api/packages`,
- the frontend source files it executed, via V8 coverage.

Nothing is inferred from test names, so the map stays correct when tests are refactored. It also
derives `backendOwners` by parsing the `app.use()` mounts, which is what joins a changed route
file to the endpoints it owns:

```
app.use('/api/destinations', destinationsRouter)
  -> /api/destinations -> backend/src/routes/destinations.ts
  -> every test that called GET /api/destinations
```

To build the equivalent for another stack, record per test: endpoints called, source files
executed, routes visited. The format matters less than the fact that it is **observed, not
guessed**.

**Refresh them when tests change**, or selection silently degrades. Voyagenie enforces the
inventory in CI:

```bash
npm run inventory:check   # regenerate, then git diff --exit-code
```

The coverage map needs a periodic instrumented run — after adding tests, and after any change to
routing or mounts.

If you have neither file, set both keys to `null` and declare `impact.path_conventions` instead
(timesheet-app maps `routes/clients.js` → `__tests__/routes/clients.test.js`). That resolves
backend files and resolves nothing for frontend ones, which the reports will say.

## Step 5 — Declare the rails

The rails are how the chain behaves when evidence is missing. Get these wrong and you either test
everything forever or miss the change that mattered.

```yaml
impact:
  force_full:        # any match runs the whole suite, whatever the map says
    - db/*.sql
    - .env.example
    - "**/package.json"
  mandatory_specs:   # standing policy, runs on every PR
    - e2e/guardrails.spec.ts
  critical_paths:    # uncovered change here => RED, not a footnote
    - backend/src/index.ts
    - backend/src/routes/**
  low_signal:        # heartbeat only, no functional signal to gain
    - "**/*.md"
    - devin/**
  unmapped_paths:    # no map can resolve these; representative test + reported gap
    - ai-service/**
```

**`critical_paths` is the one that changes verdicts.** A changed file in that list which no test
exercises makes the run red for `uncovered_critical`, because an unverified security fix is not a
passing run. Everything else uncovered is amber. It is declared here rather than judged per run,
so the same PR cannot change colour between runs — a run may escalate amber→red for a file the
list missed, naming it, but never the reverse.

Choose it as the code where "no test covers this" is unacceptable:

```yaml
# voyagenie                        # timesheet-app
- backend/src/index.ts             - backend/src/server.js
- backend/src/config.ts            - backend/src/middleware/**
- backend/src/routes/**            - backend/src/routes/auth.js
- ai-service/app/guardrails.py     - backend/src/validation/**
- db/*.sql                         - backend/src/database/**
```

timesheet-app deliberately omits `frontend/**`: nothing there has automated coverage, so making
every frontend change red would make the signal worthless. Marking `devin/**` low-signal matters
too — PRQE's own tooling cannot affect the application, and without that line a one-file tooling
change forced all 35 voyagenie tests.

## Step 6 — Pre-flight

Run these before the first real chain. All are cheap and each has caught something:

```bash
python3 -c "import yaml; yaml.safe_load(open('devin/config.yaml'))"          # config parses
python3 devin/tools/tickets.py --repo . --base <base> --head <head> --out /tmp/t.json
python3 devin/tools/heartbeat.py --backend-url <url> --frontend-url <url> --out-dir /tmp/hb
python3 devin/tools/publish_report.py --file /tmp/hb/heartbeat.md \
  --json-file /tmp/hb/heartbeat.json --reporttype heartbeat-report \
  --pr-id 0 --appname <appname> --repository <repo-url>
python3 devin/tools/agent_log.py --appname <appname> --pr-id 0 --run-id preflight \
  --stage heartbeat --status passed --started-at $(date +%s) --acus 0
<the functional command from config.yaml>                                    # runs as configured
```

Checklist:

- [ ] every path in `config.yaml` exists
- [ ] heartbeat exits 0 against a healthy environment **and** non-zero against a broken one
- [ ] no heartbeat check writes application data
- [ ] `tickets.py` finds every remediation commit
- [ ] selection inputs exist, or `path_conventions` is declared
- [ ] `critical_paths` covers the security-relevant surface
- [ ] a publish returns a document id
- [ ] an agent-log row returns an id, and the same command against an unreachable endpoint still
      exits 0 — telemetry must not be able to fail a stage
- [ ] `appname` is this repo's — ids are `{appname}_{reporttype}_{pr_id}`, and a stale value files
      your reports under another repo's id

---

# Part 2 — For CRaaS operators: triggering a run

## When to trigger

**After deployment, not when the PR is raised.** Every stage except PR analysis tests a running
environment; there is nothing to heartbeat before the deploy.

## What P0 needs

Start a session with the orchestrator playbook and supply:

| Input | Example | Required |
| --- | --- | --- |
| `pr_id` | `18` | yes |
| `repository` | `https://github.com/.../voyagenie/` | yes |
| `appname` | `voyagenie` | yes — it names the documents |
| service URLs | `backend_url`, `frontend_url`, `ai_url` | as the repo's config declares |
| `commit` | deployed SHA | recommended — the heartbeat asserts it |
| `environment` | `qa2` | optional label |

**The URLs must be network-reachable.** Sub-agents are child sessions on their own VMs and cannot
reach a `localhost` stack; with a local environment the whole chain has to run in one session.

## The playbooks

| Stage | Macro | Id |
| --- | --- | --- |
| Orchestrator | `!prqe_run` | `playbook-7126647262cf4d74bf7e00f1d7498c3b` |
| PR analysis | `!prqe_pr_analysis` | `playbook-0e757ba5b9b94820842c30bd5e75a8f2` |
| Heartbeat | `!prqe_heartbeat` | `playbook-d10456a91e6c4157a1396e8fc496fcea` |
| Functional | `!prqe_functional` | `playbook-f0cdc4ec4d484cd890fa4c1016237c97` |
| Performance | `!prqe_performance` | `playbook-470ed71b5ba74b898e2409d1e56a5509` |
| Final analysis | `!prqe_final` | `playbook-0ed4bea7941b4dc9af330668815b5659` |

Only `!prqe_run` is invoked directly. Heartbeat always runs. Functional and performance run when
recommended **and** available. Performance never runs concurrently with functional — load against
the same environment distorts functional timings.

**Not every stage gets its own session.** PR analysis, functional and performance are dispatched
as child sessions; heartbeat and final analysis run inside the orchestrator's. A stage's cost is
mostly the machine it runs on — boot a VM, clone the repository, re-read context it was already
sent — and those two stages need nothing the orchestrator does not already have: heartbeat is a
script and a publish, and the final analysis reasons over markdown the orchestrator is holding.
Moving them cut a run from ~11 ACUs to ~6 with no change to what is checked or published. Each
still produces its own document and its own agent-log row, so nothing downstream can tell the
difference.

A PR whose every changed path is low-signal takes a fast path: the orchestrator reads the diff,
judges that there is no functional signal to gain, and runs heartbeat and the verdict alone. It
is a judgement, not a glob match — a "documentation" change to a file the application loads gets
the full chain.

## What comes back

Each stage POSTs its own document with both `analysis_markdown` and a populated `analysis_json`:

| Stage | `reporttype` | Document id |
| --- | --- | --- |
| PR analysis | `prqe-analysis` | `voyagenie_prqe-analysis_18` |
| Heartbeat | `heartbeat-report` | `voyagenie_heartbeat-report_18` |
| Impact | `impact-analysis` | `voyagenie_impact-analysis_18` |
| Functional | `regression-report` | `voyagenie_regression-report_18` |
| Performance | `perf-report` | `voyagenie_perf-report_18` |
| Final | `verdict-report` | `voyagenie_verdict-report_18` |

**Ids are `{appname}_{reporttype}_{pr_id}`, so re-running a PR overwrites its previous reports**,
and two stages sharing a report type overwrite each other. Heartbeat has its own type for exactly
that reason.

The final report uses **one type for every colour**. It previously split red out as
`failure-analysis`, which meant a PR whose verdict changed between runs left its old document
behind under the other id — two reports for one PR, one of them stale, with nothing marking which
was current. Read the colour from the `verdict` field, not from the document's name: a missing
report now means the chain never reached the final stage, which is a different problem from a
failing run.

`failure-analysis` remains a valid type in the API, so documents from before the change still
resolve: `voyagenie_failure-analysis_25`, `voyagenie_failure-analysis_18`.

## Run stats

Separately from the reports, every stage writes one row to the agent-log API as its last action —
what it did, how long it took, what it cost:

```json
{"appname": "timesheet-app", "pr_id": "181", "run_id": "20260804T0410",
 "stage": "functional", "status": "passed", "duration_seconds": 540, "acus_consumed": 4.8,
 "counts": {"executed": 26, "passed": 22, "failed": 4, "not_executed": 6},
 "report_ids": ["timesheet-app_regression-report_181"]}
```

Rows are keyed `{appname}_{pr_id}_{stage}_{run_id}` and **accumulate** — the opposite of the report
ids, deliberately: cost and duration only mean something as a series, so a re-run must not erase
what the last one cost. Unlike the report API, this one can be read back:

| | |
| --- | --- |
| `GET /agent-log/{appname}/runs/{run_id}` | every stage of one chain, plus totals |
| `GET /agent-log/{appname}/summary` | per-run totals, newest first — the trend view |
| `GET /agent-log/{appname}?pr_id=&stage=` | raw rows |

Two things to read carefully:

- **`status` is the stage, `verdict` is the conclusion.** A red verdict reached successfully is
  `status: passed, verdict: red`. Conflating them makes every failing run look like a broken
  pipeline.
- **`acus_are_floor: true` means the number is a lower bound**, not a total. A session cannot read
  its own final ACU figure while it is still running, so the orchestrator's row — and therefore
  any total including it — is a floor until the sessions API is queried afterwards.
- **Every row carries its own stage's cost, and the run total is the sum.** The orchestrator row
  is this session's own consumption, which includes the heartbeat and final-analysis work it now
  performs. It previously carried the *sum of its children*, which made `/summary` report 12.68
  ACUs for a run that actually cost 11.08.

The same container holds CRaaS's own per-PR text logs (`PR163`, one free-text `agentLog` field).
Those are written by the command centre and overwrite per PR; rows from this chain carry
`doctype: agent_log`.

## Reading the verdict

```json
{"verdict": "red", "verdict_reason": "uncovered_critical"}
```

| Verdict | Reason | What it means |
| --- | --- | --- |
| green | `all_passed` | covered and passing |
| amber | `uncovered_minor` | nothing failed, non-critical code unverified |
| amber | `environment` | environment degraded, no regression found |
| red | `failures` | tests failed — **fix the code** |
| red | `uncovered_critical` | critical code unverified — **write the test** |

The reason matters more than the colour: the two reds are days apart in effort.

Ticket statuses are `passed`, `failed` and `no_coverage`. Read `no_coverage` literally — for a
security remediation, "nothing asserts this" and "this is verified" are opposite findings. Each
ticket also carries `security_property_asserted`, which is the honest version of `passed`:

> voyagenie #18 fixed three vulnerabilities and the full suite went green. Every ticket had
> `security_property_asserted: false` — the covering tests asserted the behaviour that *did not*
> change (POST still works, docs still serve in dev). **Reverting all three fixes would not have
> failed a single test.** The run is red on `uncovered_critical`, which is the finding.

The same verdict object appears twice: as `analysis_json`, and as a fenced block after
`<!-- prqe-verdict -->` at the end of the markdown for humans. To parse the markdown copy:

```python
m = re.search(r"<!--\s*prqe-verdict\s*-->\s*```json\s*(\{.*?\})\s*```", markdown, re.S)
```

---

# Reference

## Config keys

| Key | Purpose |
| --- | --- |
| `app.name`, `app.repository` | identity; `app.name` prefixes every document id |
| `services.*` | which URLs the run requires |
| `heartbeat.script`, `command`, `expectations`, `exit_codes` | the availability gate |
| `publisher.command` | how every stage POSTs its report |
| `agent_log.command`, `agent_log.endpoint` | how every stage records its run stats |
| `impact.spec_inventory`, `impact.coverage_map` | selection inputs; `null` ⇒ path conventions |
| `impact.backend_mounts` | file parsed to map route files to endpoints |
| `impact.force_full` / `mandatory_specs` / `critical_paths` / `low_signal` / `unmapped_paths` | the rails |
| `functional.runner`, `command`, `select_flag`, `working_dir`, `env` | how to run tests |
| `functional.targets_deployed_environment` | whether a green run says anything about the deploy |
| `performance.runner`, `command`, `triggers` | load test and when to recommend it |
| `reports.types` | the `reporttype` per stage |

## Known gaps

| | voyagenie | timesheet-app |
| --- | --- | --- |
| Heartbeat | 22 checks, enumerated from OpenAPI | 10 checks, explicit list |
| Spec inventory | yes | yes (PR #180) |
| Coverage map | yes, observed at runtime | yes, observed at runtime (PR #180) |
| Functional targets the deploy | yes, Playwright over HTTP | yes, Playwright over HTTP (PR #180) |
| Performance | k6 | **none** |
| Frontend coverage | V8, per test | V8, per test (PR #180) |

Two gaps are not repo-specific and neither is closed:

- **No playbook builds the selection inputs.** They come from repo-local scripts (step 4), so each
  new repo repeats that work by hand.
- **No stored performance baseline per commit.** Without one, k6 can say "within thresholds" but
  never "no regression". The agent-log rows now make the *cost* of a run trendable; the same is
  still missing for its latency.

`functional.targets_deployed_environment: false` is the one to remember for timesheet-app: a green
functional stage there says nothing about the deployed environment. Only the heartbeat does.

Two things that would improve the chain across all repos, neither of which exists yet:

- **a playbook for generating the selection inputs**, so a new repo does not have to hand-build
  what voyagenie's `tests/scripts/` and `tests/reporters/` do;
- **stored performance baselines per commit** — without them a k6 run reports "within thresholds",
  never "no regression".

## Editing a playbook

For the orchestrator, PR analysis, functional and performance: change the live copy in Devin —
that is what runs — and mirror the change into `devin/playbooks/` so the repo keeps the history.
Editing only the mirror changes nothing.

For `p2-heartbeat.md` and `p5-final-analysis.md` it is the other way round: the orchestrator reads
them from the clone, so the repo copy is what runs. Keep the Devin copy in step anyway — it is
what a dispatched child session would follow.

## What a run costs

Measured on voyagenie, from the sessions API after the sessions settled:

| | Before | After |
| --- | --- | --- |
| Typical run, performance skipped | 11–12 ACUs | ~6 |
| With performance | ~15 | ~8 |
| Whole diff low-signal | 11 | ~1 |

None of that came from testing less. The functional suite runs in about 20 seconds; the cost was
five VMs each booting, cloning and re-reading context before doing a few seconds of work. The
savings are: heartbeat and final analysis in the orchestrator's session, the change set travelling
in the prompt instead of being re-derived, shallow clones, the test toolchain baked into the
snapshot rather than installed per run, children terminated when their output is captured, and one
ACU-backfill pass at the end instead of one per child.
