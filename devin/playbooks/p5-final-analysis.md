Playbook: PRQE Final Analysis

> **This file is what runs.** The orchestrator executes this stage inside its own session and
> follows this copy from the clone; the playbook stored in Devin is kept in step with it for the
> case where the stage is dispatched as a child session instead. Change both.


## Overview
Reads every stage report from one PRQE run, attributes each failure to a root cause **and to the
remediation ticket that caused it**, and issues the run's verdict. Publishes one markdown document
to the CRaaS PR QE Impact API — the verdict report, whatever the colour — and returns the verdict
to the orchestrator. The document ends with a machine-readable verdict block that CRaaS parses.

Repository-independent: the repo's `devin/config.yaml` supplies the report types.

This stage reasons over reports the orchestrator is already holding, so it runs in that session
rather than in a VM of its own — a child spent most of its cost re-reading context it had been
sent. The judgement is unchanged: the same inputs, the same rails, the same verdict document and
the same agent-log row under `--stage final`.

## What's Needed From User
- `pr_id`, `repository`, `appname`
- The markdown of every stage that ran: PR analysis, heartbeat, impact analysis, functional,
  performance
- The heartbeat verdict and which stages were skipped, with reasons
- The **ticket map** from the orchestrator: `ticket -> commits -> changed files`, including the
  `_untracked` bucket for commits with no ticket id
- Optional: `commit`, `environment`, `run_id`

## Procedure
1. Read `devin/config.yaml` for the `verdict` report type. Running inside the orchestrator's
   session, the clone, the config and every stage's markdown are already to hand — use them, and
   note the start time for the agent-log row.
2. Build the stage table: every stage, its status (`passed` / `failed` / `skipped` / `error`),
   its key numbers and its CRaaS document id. A skipped stage must carry the reason it was
   skipped — an unexplained gap reads as a silent pass.
3. Attribute each failure to a cause rather than restating it:
   - **environment** — the heartbeat was unhealthy, or failures cluster on connectivity, 5xx,
     timeouts and missing assets;
   - **regression** — the heartbeat was healthy and the failures fall in code the diff touched;
   - **test defect or flake** — the failure is in the test rather than the product;
   - **unknown** — say so plainly instead of picking the most convenient cause.
4. Group failures that share a root cause. Twenty tests failing on one broken endpoint is one
   finding, not twenty.
5. **Attribute every failure to a ticket.** For each failing test, resolve the source files it
   exercises (the coverage map's `bySourceFile` and `byEndpoint`, or the config's
   `impact.path_conventions` where no map exists) and intersect them with each ticket's changed
   files.
   - One ticket matches → the failure belongs to it.
   - Several match → judge from the diff which change plausibly caused the failure. If the
     judgement is genuinely undecidable, attribute the failure to **all** matching tickets and
     mark each `failed`; never pick one arbitrarily to keep the table tidy.
   - None match → `non_ticket_related`, including anything traced to `_untracked` commits.
6. Set each ticket's status:
   - `failed` — at least one failure attributed to it;
   - `passed` — it has covering tests and none of them failed;
   - `no_coverage` — no test exercises any file it touched. Never report this as `passed`: for a
     security remediation, "nothing asserts this" and "this is verified" are opposite findings.
   Also record whether the fix's actual security property is asserted, rather than only that
   nothing else broke — a ticket whose tests would still pass if the fix were reverted is not
   verified, and the report must say so.
7. Carry forward the findings that survive a green run: defects the PR analysis named, and the
   coverage gaps the impact analysis reported. A change no test asserts is not validated by a
   green suite, and this is the last place anyone will read that.
8. Decide the verdict — `green`, `amber` or `red` — **and always state its reason**, because red
   for a failing test and red for uncovered code demand opposite actions (fix the code versus
   write the test):

   | Situation | Verdict | `verdict_reason` |
   | --- | --- | --- |
   | Failures attributed to the diff | `red` | `failures` |
   | Changed code matching `impact.critical_paths` that no test exercises | `red` | `uncovered_critical` |
   | Uncovered changed code outside those paths | `amber` | `uncovered_minor` |
   | Heartbeat unhealthy but no regressions | `amber` | `environment` |
   | Every changed path covered, every stage passed | `green` | `all_passed` |

   Critical paths come from the config, so the same PR does not change colour between runs. You
   may **escalate** `amber` to `red` when a changed file is plainly critical and the list missed
   it — naming the file and the reason in the report — but never de-escalate `red` to `amber`.
   A ticket whose changed files are in `impact.critical_paths` and whose status is `no_coverage`
   makes the run `red`: an unverified security fix is not a passing run.
   A skipped stage does not block green, but must be visible in the table.
9. Write the markdown: verdict first with a one-line justification, stage table, **ticket table**,
   failure attribution, findings that survive, coverage gaps, and a single recommended next
   action.
10. Write the verdict in the schema below to `{report_dir}/verdict.json`, **and** append it to the
    markdown as an HTML comment marker `<!-- prqe-verdict -->` followed by one fenced ```json
    block. The file is what CRaaS consumes; the block keeps the verdict readable for anyone
    looking at the report itself. Emit exactly one such block per report and strip backticks from
    any embedded test name or error message, or the fence closes early. The two must be byte-for-
    byte the same object.
11. Publish with the `verdict` report type — **the same type for green, amber and red** — passing
    `--json-file {report_dir}/verdict.json` so the verdict lands in `analysis_json` as a real
    object rather than something CRaaS has to regex out of the markdown. One id per PR means a
    run that changes colour replaces its predecessor instead of leaving a stale document under a
    second name; the colour is read from `verdict`, not from the document's name.
12. Record the stage in the agent log as the **last action, whatever the outcome**, using
    `agent_log.command` from the config. This is the only row that carries the verdict, so a
    dashboard can answer "how did this run end" without reading a report:

    ```
    python3 devin/tools/agent_log.py --appname <appname> --pr-id <pr_id> --run-id <run_id> \
      --stage final --status passed --started-at <epoch taken before step 1> \
      --commit <commit> --environment <environment> --report-ids <published document id> \
      --verdict amber --verdict-reason environment \
      --tickets '{"VIT0016231": "passed", "VIT0016237": "no_coverage"}'
    ```

    `--status` is whether this analysis ran; `--verdict` is what it concluded. A red verdict
    reached successfully is `--status passed --verdict red`, and conflating the two would make
    every failing run look like a broken pipeline.
13. Return the structured output plus the markdown to the orchestrator.

## Verdict block schema

```json
{
  "schema_version": 1,
  "pr_id": "18", "appname": "voyagenie", "commit": "558db74",
  "verdict": "green", "verdict_reason": "all_passed",
  "escalations": [{"from": "amber", "to": "red", "file": "...", "reason": "..."}],
  "tickets": [
    {"ticket_id": "VIT0016042", "status": "passed", "commits": ["1885c73"],
     "files": ["backend/src/routes/contact.ts"],
     "tests_covering": 1, "tests_passed": 1, "tests_failed": 0, "failed_tests": [],
     "security_property_asserted": false,
     "note": "Covering test asserts POST still works; nothing asserts the removed GET is gone."}
  ],
  "non_ticket_failures": {"count": 0, "tests": []},
  "regression_summary": {"availability": "Pass", "functional_regression": "Pass",
                         "performance_regression": "NA"},
  "test_case_summary": {"total_impacted": 0, "total_mandatory": 7,
                        "total_rail_escalated": 28, "total_executed": 35,
                        "total_passed": 35, "total_failed": 0,
                        "selection_mode": "full_suite", "selection_reason": "..."},
  "uncovered": [{"path": "backend/src/index.ts", "critical": true,
                 "reason": "no test asserts the hardening headers"}],
  "failed_tests": [{"test": "...", "error": "...", "ticket_id": "VIT0016042",
                    "attribution": "regression"}],
  "coverage_gaps": ["..."],
  "heartbeat": {"verdict": "healthy", "passed": 22, "failed": 0, "skipped": 1},
  "performance": {"verdict": "pass", "p95_ms": 10.56, "failed_requests": 0}
}
```

`regression_summary` values are `Pass`, `Fail` or `NA`: `availability` from the heartbeat
(unhealthy ⇒ `Fail`, and ticket statuses stay as measured so a deploy fault is never read as an
unfixed vulnerability), `functional_regression` from the functional stage, and
`performance_regression` `NA` when performance did not run.

The four count fields are deliberately separate and must satisfy
`total_impacted + total_mandatory + total_rail_escalated = total_executed`:

- `total_impacted` — tests the diff actually selected. Zero is a meaningful answer.
- `total_mandatory` — `impact.mandatory_specs`, standing policy on every PR.
- `total_rail_escalated` — tests run only because the selector could not map a changed path. This
  is the selector admitting ignorance, and a number that should shrink as coverage improves;
  folding it into "mandatory" would hide that.
- `total_executed` — what ran, so the arithmetic is checkable rather than implied.

## Specifications
- Structured output: `verdict` (`green` / `amber` / `red`), `verdict_reason` (`all_passed` /
  `failures` / `uncovered_critical` / `uncovered_minor` / `environment`), `root_causes`, `stages`,
  `tickets`, `uncovered`, `coverage_gaps`, `next_action`, `report_id`, `final_markdown`.
- Every verdict carries a reason; a colour on its own does not say which action it demands.
- Every entry in `uncovered` states whether the path is critical and why it is uncovered.
- Every failed stage has exactly one attributed cause; every failing test has a ticket id or
  `non_ticket_related`.
- Every ticket in the map appears in the table and the JSON, including ones with no coverage.
- Deliverable: one published document carrying the markdown (ending in exactly one verdict block)
  and the same verdict as `analysis_json`, plus the markdown returned in-session.
- One agent-log row under the orchestrator's `run_id`, carrying the verdict, its reason and the
  per-ticket statuses — and never conflating stage status with verdict.
- Validation: the stage table accounts for all five stages, including the skipped ones; the
  verdict block parses as JSON; and the published `analysis_json` equals it.

## Advice and Pointers
- The verdict must be readable in five seconds: state it before the detail.
- Environment failures and regressions demand different actions — retry the deploy versus fix the
  code. Getting that attribution wrong wastes the most time of anything in this chain.
- Do not soften a green verdict into a warning, or a red one into "mostly fine". Report the
  verdict, then the caveats.
- The most valuable line in this report is usually the next action. Make it specific: which file,
  which change, which stage to re-run.
- For vulnerability remediations the coverage gap *is* the finding. A green run against a ticket
  with no covering test says only that nothing else broke; say that in those words rather than
  letting `passed` imply the vulnerability is closed.
- Attribution is only as good as the coverage map. Where a repo has none, path conventions resolve
  backend files and resolve nothing for frontend ones — state which mechanism produced each
  attribution so a wrong one can be challenged.

## Forbidden Actions
- Do not re-run tests or start services; this stage reasons over reports only.
- Do not report green when a stage errored — an error is not a skip.
- Do not attribute a failure to flake without evidence.
- Do not report a ticket as `passed` when no test exercises the files it changed.
- Do not de-escalate a `red` to `amber`, and do not issue a verdict without its reason.
- Do not treat uncovered critical code as green because nothing failed — nothing ran.
- Do not drop a failure that maps to no ticket; report it as non-ticket-related.
- Do not emit more than one fenced `json` block, or place the verdict block anywhere but last.
- Do not omit a stage from the table because it was skipped.
- Do not comment on the pull request.
- Do not log `--status failed` because the verdict was red; the analysis succeeded.
