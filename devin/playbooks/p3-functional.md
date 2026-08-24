Playbook: PRQE Functional

> Mirror of the playbook stored in Devin, kept here for review and history.
> Editing this file changes nothing about a run — apply the change in Devin too.


## Overview
Selects the tests a pull request's diff actually justifies, runs them against the deployed
environment, and reports both the selection reasoning and the result. Publishes two markdown
documents to the CRaaS PR QE Impact API — impact analysis and the functional result — and
returns both to the orchestrator.

Repository-independent: the repo's `devin/config.yaml` declares the test runner, the selection
inputs and the rails.

## What's Needed From User
- `pr_id`, `repository`, `appname`
- The deployed service URLs the config declares
- The heartbeat verdict, so results can be attributed correctly
- Optional: `commit`, `environment`, `run_id`

## Procedure
1. Clone the repository — `git clone --filter=blob:none --depth 200` is enough, deepen only if
   the merge base is missing — and read `devin/config.yaml`. Read the config, not
   `devin/README.md`: that file is onboarding documentation for repository owners and contains
   nothing this stage acts on. If `functional.runner` is null, report the stage as unavailable,
   say what the repo would need, and stop.
2. Collect the change set: commit list, changed files and the full diff against the merge base.
   The orchestrator's prompt carries the file list and ticket map — start from those and read the
   diff for the files that matter, rather than re-deriving the set from git.
3. Load the selection inputs the config names — `impact.spec_inventory` (the closed vocabulary of
   tests that exist) and `impact.coverage_map` (recorded evidence of what each test exercises).
   Where they are null, fall back to `impact.path_conventions` and lower your confidence
   accordingly.
4. Apply the deterministic rails first. An unmapped path is classified, not blanket-escalated —
   "the selector cannot see this file" and "this file is harmless" are different findings:

   | Changed path | Tests run | Reported as |
   | --- | --- | --- |
   | `impact.force_full` | full suite | — |
   | `impact.low_signal` | none | `no_impact` |
   | `impact.unmapped_paths` | mandatory specs + one representative test | **uncovered** |
   | no mapping, matches `impact.critical_paths` | full suite | **uncovered, critical** |
   | no mapping, anything else | full suite | **uncovered** |

   - `impact.mandatory_specs` are always included, whatever the diff touched — an app-code change
     never runs zero tests;
   - a path never gets a pretended mapping: where the evidence is missing, the report says so.

   Every uncovered path is listed for the final analysis with `critical: true|false` from
   `impact.critical_paths`, because uncovered critical code makes the run red while uncovered
   minor code makes it amber.
5. Within those rails, select the tests the diff justifies: join changed backend files to the
   endpoints they own (via `impact.backend_mounts`) and then to the tests that called those
   endpoints; join changed frontend files through the coverage map's per-file evidence. Record
   *why* each test was selected.
6. Validate every selected test against the inventory before running anything. An unrecognised
   name means the inventory moved or the selection is wrong — fall back to the full suite rather
   than quietly testing less than you claim.
7. If the selection is empty, skip execution and report the reason. Never pass an empty selector:
   an empty `--grep` matches every test, turning "nothing to run" into "run everything".
8. Write and publish the impact analysis (`impact` report type): selection counts, the reasoning
   per test, rails that fired, and the coverage gaps — the changes the selected tests cannot
   validate. Publish the same content as JSON via `--json-file` (selected tests with their
   reasons, rails fired, gaps): the API requires `analysis_json`, and the selection is the part
   CRaaS most needs to query.
9. Run the selection with `functional.command` and `functional.select_flag`, in
   `functional.working_dir`, with `functional.env` pointing at the deployed URLs. Run
   `functional.install` only when the toolchain is not already present — the VM's snapshot may
   ship it, and reinstalling browsers on every run is minutes of wall clock for no signal.
10. Write and publish the functional report (`functional` report type): environment, heartbeat
    verdict, selection size, pass/fail/skip counts, duration, every failure with its error, and a
    short section on what a green run does *not* prove. Publish the counts and failures as JSON
    via `--json-file` as well.
11. Record the stage in the agent log as the **last action, whatever the outcome**, using
    `agent_log.command` from the config. This stage owns two report types, so log two rows — one
    for the selection, one for the execution — or the impact stage disappears from the run's cost:

    ```
    python3 devin/tools/agent_log.py --appname <appname> --pr-id <pr_id> --run-id <run_id> \
      --stage impact --status passed --started-at <epoch before step 3> \
      --report-ids <impact document id> \
      --counts '{"impacted": 5, "mandatory": 7, "rail_escalated": 20, "selected": 32,
                 "total": 35}'

    python3 devin/tools/agent_log.py --appname <appname> --pr-id <pr_id> --run-id <run_id> \
      --stage functional --status failed --started-at <epoch before step 9> \
      --commit <commit> --environment <environment> --report-ids <functional document id> \
      --counts '{"executed": 26, "passed": 22, "failed": 4, "not_executed": 6}'
    ```

    `executed` must exclude tests that were selected but never ran — a throttled or unreachable
    target makes those `not_executed`, and counting them as passed is the one number in this
    chain nobody would catch being wrong. A skipped execution (empty selection, null runner) is
    logged `--status skipped` with the reason in `--notes`, not omitted.
12. Return the structured output and both markdown documents to the orchestrator.

## Specifications
- Structured output: `selected`, `total`, `passed`, `failed`, `skipped`, `fallback_reason`,
  `impacted`, `mandatory`, `rail_escalated`, `uncovered` (each with `path`, `critical`, `reason`),
  `coverage_gaps`, `impact_report_id`, `functional_report_id`, `impact_markdown`,
  `functional_markdown`.
- Two agent-log rows under the orchestrator's `run_id`: `impact` and `functional`.
- `impacted + mandatory + rail_escalated` equals the number of tests executed, so the final
  report's counts are checkable rather than implied.
- The number of tests executed must equal the number selected; report any discrepancy.
- Deliverable: two published documents, each carrying both its markdown and its JSON, and both
  markdowns returned in-session.
- Each `analysis_json` mirrors the structured output; the two must not disagree.
- Validation: every selected test exists in the inventory, and both publishes succeeded.

## Advice and Pointers
- Coverage gaps are often worth more than the pass result. A change no test asserts will pass a
  fully green suite — say so explicitly rather than implying the change was validated.
- Selection reasoning must name the evidence (endpoint, source file, rail), so a reviewer can
  challenge it. "Related to the diff" is not a reason.
- A test map only knows about code the suite already exercises. Absence from the map is a
  coverage gap to report, not permission to skip.
- Attribute failures with the heartbeat verdict: failures on an unhealthy environment are
  environment failures until proven otherwise.

## Forbidden Actions
- Do not run a selection that was not validated against the inventory.
- Do not pass an empty selector to the runner.
- Do not modify tests, application code or the deployed environment to make a run pass.
- Do not claim a change is validated when no test asserts it.
- Do not skip publishing the impact analysis when the functional stage fails — the selection
  reasoning is what makes the failure interpretable.
