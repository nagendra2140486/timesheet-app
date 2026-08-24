Playbook: PRQE PR Analysis (P1)

> Mirror of the playbook stored in Devin, kept here for review and history.
> Editing this file changes nothing about a run — apply the change in Devin too.


## Overview
Reads a pull request's commits and full diff, judges risk, names likely defects, and recommends
which suites the orchestrator should run. Publishes its markdown to the CRaaS PR QE Impact API
and returns it to the orchestrator. Analysis only — it runs no tests and touches no environment.

Repository-independent: read the repo's `devin/config.yaml` for report types, force-full paths
and low-signal paths rather than assuming any layout.

## What's Needed From User
- `pr_id`, `repository`, `appname`
- `run_id` — the orchestrator's id for this chain; every stage logs under it
- Optional: the orchestrator's ticket map (`ticket -> commits -> changed files`) and change set
  (changed files and diffstat)
- Optional: `commit` (the deployed SHA), `environment`

## Procedure
1. Clone the repository — `git clone --filter=blob:none --depth 200` is enough, deepen only if
   the merge base is missing — and read `devin/config.yaml`. Read the config, not
   `devin/README.md`: that file is onboarding documentation for repository owners and contains
   nothing this stage acts on.
2. Establish the change set against the merge base, not the branch tip:
   `git diff --merge-base origin/<base> origin/<head>`. Also collect the commit list
   (`--no-merges`, with per-commit stats) and how far the branch is behind base. When the
   orchestrator supplied the change set and ticket map, take the file list from there and spend
   the effort on reading the diff itself rather than re-deriving what you were given.
3. Read the full diff. For each changed file record the layer it belongs to and what actually
   changed — text, logic, schema, configuration, dependency.
4. Classify each commit against its real content. Call out commits that are empty, whose message
   misdescribes the change, or that do the opposite of what they claim.
5. Identify likely defects from the diff itself: debug or placeholder text left in user-visible
   strings, inverted conditions, dropped error handling, widened permissions, secrets, changes
   to validation or authentication. Quote file and line.
6. Judge risk as low / medium / high from blast radius, not from line count. A one-line change to
   a config value or an auth check is not low risk.
7. Recommend each suite with a reason:
   - heartbeat — always `true`.
   - functional — `true` unless every changed path is in the config's `low_signal` list. Name any
     changed path that matches `impact.critical_paths`: uncovered critical code makes the run red,
     so the final analysis needs it flagged from the start.
   - performance — `true` only when a changed path matches `performance.triggers`, or the diff
     plausibly affects latency (queries, loops, payload size, caching, dependencies).
   Anything matching `impact.force_full` also means functional `true` with full-suite scope.
8. Write the markdown report: context table, change set, commit table **with each commit's ticket
   id**, the list of tickets in the PR, findings, and the recommendation table with reasons. Take
   the ids from the orchestrator's ticket map when supplied; otherwise match `\bVIT\d{5,}\b` in
   each commit's title and body. A commit with no id is reported as untracked rather than being
   attached to the nearest ticket — the final analysis relies on that distinction.
9. Write the same result as JSON to `{report_dir}/pr-analysis.json` — the structured output's
   fields, plus `tickets` — and publish both with the config's publisher and the `pr_analysis`
   report type, passing `--json-file {report_dir}/pr-analysis.json`. The API requires
   `analysis_json`, and sending the real object rather than `{}` is what lets CRaaS query the
   recommendation without parsing markdown. Confirm the POST succeeded — a failed publish means
   the report is lost.
10. Record the stage in the agent log as the **last action, whatever the outcome**, using
    `agent_log.command` from the config:

    ```
    python3 devin/tools/agent_log.py --appname <appname> --pr-id <pr_id> --run-id <run_id> \
      --stage pr-analysis --status passed --started-at <epoch taken before step 1> \
      --commit <commit> --environment <environment> --report-ids <published document id> \
      --counts '{"commits": 2, "files_changed": 6, "tickets": 2, "findings": 3}' \
      --extra '{"risk": "medium"}'
    ```

    Take the timestamp before step 1, so the duration covers the stage rather than its last
    command. Log `--status failed` or `error` when that is what happened: the stage that died is
    the one whose row matters. The tool exits 0 even when the write fails, so this never turns a
    completed stage into a failed one — but say in the return whether the row was written.
11. Return the structured output plus the markdown to the orchestrator.

## Specifications
- Structured output: `risk`, `recommend.heartbeat`, `recommend.functional`,
  `recommend.performance`, `findings`, `report_id`, `analysis_markdown`.
- Every ticket id found in the commits appears in the report, and every commit is either mapped
  to a ticket or explicitly untracked.
- The recommendation must be justified by named files, never by line count alone.
- Deliverable: one published `pr_analysis` document carrying both the markdown and the JSON, one
  agent-log row, and the markdown returned in-session.
- The agent-log row carries this stage's own `run_id` — the orchestrator's, never a new one, or
  the run cannot be totalled.
- `analysis_json` mirrors the structured output; the two must not disagree.
- Validation: the publish response returned success and a document id.

## Advice and Pointers
- Diff against the merge base. Diffing against the base branch tip attributes other people's
  commits to this PR.
- A branch far behind its base is worth reporting: the merge result is a combination neither
  side has tested.
- Findings that no test can catch are the most valuable output here — the later stages can only
  report on what the suite asserts.
- Keep the report readable by someone who has not seen the diff: quote the changed line.

## Forbidden Actions
- Do not run tests, start services or touch the deployed environment.
- Do not modify the repository or comment on the pull request.
- Do not recommend the full suite by default to be safe — that defeats selection; use the
  config's force-full and low-signal lists to decide.
- Do not report a publish as successful without the API's success response.
- Do not skip the agent-log row because the stage failed, and do not fail the stage because the
  row could not be written.
