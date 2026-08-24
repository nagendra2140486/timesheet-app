Playbook: PRQE Performance

> Mirror of the playbook stored in Devin, kept here for review and history.
> Editing this file changes nothing about a run — apply the change in Devin too.


## Overview
Runs the repository's critical-journey performance script against the deployed environment after
the functional stage has finished, and reports latency and error rate. Publishes its markdown to
the CRaaS PR QE Impact API and returns the verdict to the orchestrator.

Repository-independent: the repo's `devin/config.yaml` declares the runner and command.

## What's Needed From User
- `pr_id`, `repository`, `appname`
- The deployed service URLs the config declares
- The heartbeat verdict
- Optional: `commit`, `environment`, `run_id`, duration and VU overrides

## Procedure
1. Clone the repository and read `devin/config.yaml`. If `performance.runner` is null, report the
   stage as unavailable, name what the repo would need to add, and stop — do not improvise a load
   script for an app whose critical journeys have not been agreed.
2. Confirm the functional stage has finished. Load against a shared environment invalidates
   functional timings, so these two never overlap.
3. Check the environment is reachable before generating load, so a dead environment is reported
   as such rather than as a latency failure.
4. Run `performance.command` with the run's URLs substituted, exporting the runner's summary into
   the report directory.
5. Read the summary: p95 and p99 latency, iterations, checks passed and failed, HTTP error rate,
   and any threshold the script itself declares.
6. Decide the verdict from the script's thresholds, not from a number you invent. If the script
   declares no threshold, report the measurements and say explicitly that there is no pass
   criterion to judge against.
7. Write the markdown report: environment, run parameters, per-journey latency table, threshold
   results, failures, and how to read the numbers given the environment's size.
8. Publish it with the config's `performance` report type, passing the measurements as JSON with
   `--json-file` (verdict, p95, p99, iterations, failures, error rate, load profile). The API
   requires `analysis_json`, and latency numbers are the clearest case for a queryable field
   rather than prose. Confirm the POST succeeded.
9. Record the stage in the agent log as the **last action, whatever the outcome**, using
   `agent_log.command` from the config:

   ```
   python3 devin/tools/agent_log.py --appname <appname> --pr-id <pr_id> --run-id <run_id> \
     --stage performance --status passed --started-at <epoch taken before step 1> \
     --commit <commit> --environment <environment> --report-ids <published document id> \
     --counts '{"requests": 532, "failed_requests": 0}' \
     --extra '{"p95_ms": 10.88, "p99_ms": 18.4}'
   ```

   A repo with `performance.runner: null` still logs a row — `--status skipped --notes "no
   performance script in this repo"`. A stage that silently writes nothing is indistinguishable
   from one that was never dispatched.
10. Return the structured output plus the markdown to the orchestrator.

## Specifications
- Structured output: `verdict` (`pass` / `fail` / `unavailable`), `p95_ms`, `p99_ms`,
  `iterations`, `failures`, `error_rate`, `report_id`, `performance_markdown`.
- The report states the load profile used (virtual users and duration) — a latency number without
  it is meaningless.
- Deliverable: one published performance document carrying both the markdown and the JSON, and
  the markdown returned in-session.
- `analysis_json` mirrors the structured output; the two must not disagree.
- One agent-log row under the orchestrator's `run_id`, including when the stage was skipped.
- Validation: the runner exited and produced a summary file; a missing summary is a stage error,
  not a pass.

## Advice and Pointers
- A single-VU baseline run measures latency, not capacity. Say which one the numbers represent so
  nobody reads a smoke run as a load test.
- Shared or containerised environments are noisy. Compare against the previous run for the same
  environment where possible, and treat a single spike with suspicion.
- An unhealthy heartbeat makes performance numbers unreliable; report them, but flag that the
  environment was already degraded.
- Errors matter more than latency: a fast run that failed half its checks is a failure, not a
  fast result.

## Forbidden Actions
- Do not run concurrently with the functional stage.
- Do not run load against production or any environment the orchestrator did not supply.
- Do not invent a pass threshold the repository has not declared.
- Do not modify the performance script to make a run pass.
