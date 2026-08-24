Playbook: PRQE Orchestrator (P0)

> Mirror of the playbook stored in Devin, kept here for review and history.
> Editing this file changes nothing about a run — apply the change in Devin too.
>
> Exception: the heartbeat and final-analysis stages now run **inside this session** and are
> driven by `devin/playbooks/p2-heartbeat.md` and `devin/playbooks/p5-final-analysis.md` read
> from the cloned repository. For those two files the mirror *is* what runs.


## Overview
Runs the post-deploy quality chain for a pull request that has already been deployed to an
environment. Judges the diff, decides which suites to run, executes the availability gate itself,
dispatches the suites that need their own machine, and concludes with the verdict. Every stage
publishes its own markdown to the CRaaS PR QE Impact API.

Two of the five stages run in this session rather than as child sessions. Heartbeat is a single
script plus a publish, and the final analysis reasons over markdown this session is already
holding: giving each of them its own VM spent roughly two ACUs per run on booting a machine,
cloning the repository and re-reading context it had already been handed. The stages themselves
are unchanged — same procedure, same documents, same agent-log rows.

Repository-independent: everything repo-specific is declared in that repository's
`devin/config.yaml`.

## What's Needed From User
- `pr_id` — pull request number, e.g. `12`
- `repository` — e.g. `https://github.com/Cognizant-FrontierAICyberDefense/voyagenie/`
- `appname` — e.g. `voyagenie`
- Deployed environment URLs for the services the repo's config declares, typically
  `backend_url`, `frontend_url` and (where present) `ai_url`
- Optional: `environment` label (e.g. `qa2`), `commit` (the SHA that was deployed)

Reject the run and ask for the missing values if a URL required by the config is absent — the
heartbeat and functional stages cannot target an environment that was not supplied.

## Where each stage runs

| Stage | Runs | Playbook |
| --- | --- | --- |
| 1 PR analysis | child session | `playbook-0e757ba5b9b94820842c30bd5e75a8f2` |
| 2 Heartbeat | **this session** | `devin/playbooks/p2-heartbeat.md` in the clone |
| 3 Functional | child session | `playbook-f0cdc4ec4d484cd890fa4c1016237c97` |
| 4 Performance | child session | `playbook-470ed71b5ba74b898e2409d1e56a5509` |
| 5 Final analysis | **this session** | `devin/playbooks/p5-final-analysis.md` in the clone |

Child sessions return structured output, so read the fields (`recommend`, `verdict`, `passed`,
`failed`, `coverage_gaps`) rather than parsing the child's prose.

## Procedure
1. Clone the repository — shallow is enough for everything this chain does:
   `git clone --filter=blob:none --depth 200 <repository>`, deepening only if the merge base is
   not present. Read `devin/config.yaml`. If it is missing, stop and tell the user which
   capabilities cannot be resolved without it rather than guessing the repo's layout.
2. Build the ticket map with `python3 devin/tools/tickets.py --repo . --base <base> --head <head>
   --out tickets.json`, or equivalently by reading `git log --no-merges` over the merge-base
   range yourself. It matches `\bVIT\d{5,}\b` in each commit's **title and body** and produces
   `ticket -> commits -> changed files`. Commits carrying no id are collected under `_untracked`.
   Do not parse the `fix(...)` scope: CRaaS writes `fix(VIT0015739): ...` in some repos and
   `fix(security): VIT0016042 - ...` in others, and scope-parsing yields `security` for the
   second form.
3. Mint the `run_id` for this chain — `date -u +%Y%m%dT%H%M%S` — and note this session's start
   time. Every stage logs under that one id; a stage that invents its own cannot be totalled
   with the rest, and a re-run of the same PR must be a distinct id or its cost history
   overwrites itself.
4. Record the run context in a scratch file `run-context.md`: pr_id, repository, appname,
   environment, commit, the service URLs, the config path, the `run_id`, the ticket map, the
   changed-file list and the diffstat. Every sub-agent prompt must carry all of it, because child
   sessions run on their own machines and share nothing with this one — and carrying the change
   set means the child reads it instead of re-deriving it from git.
5. Look at the change set yourself before dispatching anything. If **every** changed path matches
   `impact.low_signal`, take the fast path: there is no functional signal to gain from a
   documentation or tooling change, and a child session cannot conclude otherwise. Run the
   heartbeat (step 7) and the final analysis (step 10), publish the PR-analysis document from
   this session stating the judgement and the paths it rests on, and log `pr-analysis` and
   `functional` as `skipped` with that reason. This is a judgement, not a glob check: a path that
   matches `low_signal` but plainly affects the application — a "documentation" change that edits
   an example the app loads, anything you are unsure about — means the normal path. When in
   doubt, dispatch.
6. Otherwise start the **PR Analysis** sub-agent as a child session with the run context. Wait
   for it with `devin_session_gather`, capture its structured output and markdown, then
   terminate it — a child left to idle to its inactivity timeout is charged for the wait.
7. Read the recommendation. Heartbeat always runs. Functional and performance run only if
   recommended **and** the config declares them available (`functional.runner` /
   `performance.runner` non-null). Record an unavailable stage as `skipped` with that reason.
   State the resulting plan in one line before proceeding.
8. **Run the heartbeat in this session**: read `devin/playbooks/p2-heartbeat.md` from the clone
   and follow its procedure — the script, the verdict, the publish and its agent-log row all
   belong to that playbook, not to this one. Capture the verdict (`healthy` / `unhealthy` /
   `not_ready`). Do not abort on `unhealthy` — continue with the recommended suites, but carry
   the verdict forward so downstream failures can be attributed to the environment. Its
   agent-log row is written with `--stage heartbeat` and this session's `run_id`, exactly as a
   child would have written it.
9. If functional is in the plan, run the **Functional** sub-agent as a child, including the
   heartbeat verdict and the change set in its prompt. Capture its markdown and pass/fail counts,
   then terminate it. It stays a child session deliberately: it needs its own toolchain, and it
   must not share a machine with the load generator.
10. If performance is in the plan, run the **Performance** sub-agent after functional has
    finished — never in parallel, because load against the same environment distorts functional
    timings. Terminate it once its output is captured.
11. **Run the final analysis in this session**: read `devin/playbooks/p5-final-analysis.md` from
    the clone and follow its procedure over the markdown of every stage that ran, the heartbeat
    verdict and the ticket map. It returns `green`, `amber` or `red` with a `verdict_reason`, and
    publishes the config's `verdict` report type — one type for every colour, so a PR that
    changes verdict between runs replaces its report rather than leaving a stale one behind.
    Amber means the run found no regression but could not verify something — uncovered code, or a
    degraded environment; report it as its own outcome rather than rounding it to pass or fail.
    Nothing about that stage's judgement changes because it runs here: it reasons over the same
    reports it would have been sent.
12. Verify every expected report was published: each stage's output must show a successful POST.
    A publish failure means the report is lost, so re-run that stage's publish step rather than
    reporting success. Every stage publishes both `analysis_markdown` and a populated
    `analysis_json`; a stage that published `{}` has thrown its structured result away and must
    republish.
13. Close the agent log for the run **in one pass, at the end**. Each stage that ran in a child
    session wrote its own row — do not write theirs for them while they are running, because a
    child that dies still needs the row it wrote before dying, and only it knows what it did. The
    stages that ran in this session wrote their rows as they finished. What remains is a single
    reconciliation pass over every stage:

    a. **Backfill each child's ACUs.** A session cannot read its own final `acus_consumed` while
       still running, so children log without it. After the last child has settled, read every
       child's `acus_consumed` once and re-post each row with the same `--appname --pr-id
       --run-id --stage` plus `--acus`. Do this as one loop, not as a separate read-and-post
       after each child: row ids are deterministic, so a late write replaces rather than
       duplicates. The re-post must repeat the `--status`, `--counts` and `--report-ids` the
       child reported, or the fuller row is lost.
    b. **Log a row for any stage that never reported.** A sub-agent that failed outright wrote
       nothing: log it `--status error --notes "<what happened>"`. A missing row is
       indistinguishable from a stage nobody dispatched.
    c. **Log this session's own row** — `--stage orchestrator`, the wall-clock from step 3, and
       `--acus-are-floor`. `--acus` on this row is **this session's own consumption**, which now
       includes the heartbeat and final-analysis work; it is a floor because the session is still
       accruing as it writes, and the exact figure is available afterwards from the sessions API.
       Do not put the sum of the children's ACUs in this field — a total is derived by adding the
       rows up, and a row that already contains the others double-counts the run. Record the
       children's sum in `--extra` if it is useful, never in `--acus`.

    A failed agent-log write never fails the run: the tool exits 0 and reports to stderr.
14. Summarise the run for the user: plan chosen, heartbeat verdict, per-stage outcome, per-ticket
    status, the verdict **with its reason**, the CRaaS document ids, and the single most
    actionable finding.

## Specifications
- Stages run strictly sequentially: PR analysis → heartbeat → functional → performance → final.
- Heartbeat and final analysis run in this session; PR analysis, functional and performance run
  as child sessions. Every stage still produces its own document and its own agent-log row, so
  the run's shape is unchanged from a consumer's point of view.
- The ticket map is built once, before any stage runs, and passed unchanged to every sub-agent.
- A PR with no recognisable ticket id is not an error: the run proceeds with every failure
  reported as non-ticket-related.
- Heartbeat always runs, even when the PR analysis recommends nothing else, and even on the
  low-signal fast path.
- A heartbeat failure never cancels the remaining stages, but must appear in the final report.
- Every stage that runs produces exactly one CRaaS document, using the report types in
  `reports.types` from the config.
- Deliverable: a summary to the user plus the CRaaS document ids for the run.
- One `run_id`, minted once, shared by every stage's agent-log row.
- Every dispatched stage has exactly one agent-log row, including skipped and errored ones, plus
  one `orchestrator` row for the chain carrying this session's own ACUs.
- Validation: each stage reported a successful publish, with a non-empty `analysis_json`.

## Advice and Pointers
- Sub-agents are child Devin sessions with their own VMs. They cannot reach a `localhost`
  environment on this machine — the URLs must be network-reachable, or the whole chain has to run
  in a single session instead.
- Most of a stage's cost is the machine it runs on, not the work it does: a child boots a VM,
  clones the repository and re-reads context before it starts. That is why the deterministic
  stages run here, why the change set travels in the prompt, and why children are terminated as
  soon as their output is captured.
- Stage sessions need `devin/config.yaml`, not `devin/README.md`. The README is onboarding
  documentation for repository owners; sending a child to read it spends context on prose it
  cannot act on.
- The CRaaS API is POST-only, so reports cannot be read back. Keep every stage's markdown in
  this session; the final analysis depends on it.
- Document ids are `{appname}_{reporttype}_{pr_id}`, so re-running a PR overwrites its previous
  reports, and two stages sharing a report type overwrite each other. Mention this when the user
  expects history.
- If a sub-agent fails outright, record the stage as `error` and continue; a missing stage beats
  an aborted run with no reports at all.
- Agent-log rows are the opposite of reports: keyed `{appname}_{pr_id}_{stage}_{run_id}`, they
  accumulate instead of overwriting, which is the point — cost and duration only mean anything as
  a series. The run can be read back (unlike the report API):
  `GET {agent_log.endpoint}/{appname}/runs/{run_id}` returns every stage plus totals, and
  `/summary` returns per-run totals for trends.
- That container also holds CRaaS's own per-PR text logs (`PR163`, one free-text `agentLog` field
  keyed by PR number). Those overwrite per PR and are written by the command centre, not by this
  chain; rows written here carry `doctype: agent_log` so a consumer can tell them apart.
- The ticket pattern is deliberately loose about position but strict about shape. If a repository
  uses a different prefix, change the pattern rather than falling back to reading PR titles or
  branch names — one ticket per PR is exactly what per-ticket attribution is meant to avoid.

## Forbidden Actions
- Do not run functional and performance concurrently.
- Do not skip the heartbeat, whatever the PR analysis recommends, and whatever the fast path says.
- Do not take the fast path on a diff you have not read, or on one where any changed path could
  affect the running application.
- Do not improvise the heartbeat or final-analysis procedure because they run here: follow their
  playbooks from the clone, and write their agent-log rows under their own stage names.
- Do not write a child's agent-log row on its behalf while it is still running, and do not treat
  the ACU total as exact when it includes this session's own floor.
- Do not put the children's ACU sum in the orchestrator row's `--acus`; that field is this
  session's own consumption, and a total is derived by adding the rows.
- Do not hardcode repository paths, test commands or report types that the config declares.
- Do not infer ticket ids from the PR title or branch name; commits are the only source, because
  attribution needs to know which commit touched which file.
- Do not modify application code, tests or the deployed environment.
