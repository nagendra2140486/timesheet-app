#!/usr/bin/env python3
"""Records one row per PRQE stage in the CRaaS agent-log API (craas_qea / agent_log).

Each stage calls this once, as its last action, with what the stage did and what it cost:

    python3 devin/tools/agent_log.py \
        --appname timesheet-app --pr-id 181 --run-id 20260804T0410 \
        --stage functional --status passed --started-at 1785759000 --acus 4.8 \
        --counts '{"executed":26,"passed":22,"failed":4}'

Telemetry must never fail the work that produced it, so a write failure prints to stderr and
exits 0. Pass --strict where the row is a hard requirement.

Rows are keyed {appname}_{pr_id}_{stage}_{run_id}: append-only across runs, unlike the report
documents (`{appname}_{reporttype}_{pr_id}`), which overwrite in place. Cost and duration only
mean something as a series, so re-running a PR must not erase what the last run cost.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_ENDPOINT = "https://agent-log-a5d6dxe7hbd2bxa2.canadacentral-01.azurewebsites.net/agent-log"

# The API rejects anything else; listed here so a typo fails locally rather than as a 422.
STATUSES = ("passed", "failed", "skipped", "error", "blocked")


def as_iso(value: str | None) -> str | None:
    """Accept an epoch (what `date +%s` gives a playbook) or an ISO timestamp."""
    if not value:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    except ValueError:
        return value


def as_json(value: str | None, flag: str) -> dict | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{flag} is not valid JSON: {error}")
    if not isinstance(parsed, dict):
        raise SystemExit(f"{flag} must be a JSON object")
    return parsed


def post(endpoint: str, payload: dict, timeout: float = 20.0, attempts: int = 3) -> dict:
    """POST the row, retrying 5xx — the Cosmos write path returns intermittent 500s."""
    body = json.dumps(payload).encode()
    last: Exception | None = None

    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as error:
            detail = error.read().decode()[:400]
            last = RuntimeError(f"HTTP {error.code}: {detail}")
            if error.code < 500:
                break  # a 4xx is our payload's fault and will not improve on retry
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = error
        if attempt < attempts:
            time.sleep(2 ** attempt)

    raise RuntimeError(str(last))


def build_payload(args: argparse.Namespace) -> dict:
    payload = {
        "appname": args.appname,
        "stage": args.stage,
        "status": args.status,
        "pr_id": args.pr_id,
        "run_id": args.run_id or os.getenv("PRQE_RUN_ID"),
        "repository": args.repository,
        "commit": args.commit,
        "environment": args.environment,
        "playbook_id": args.playbook_id,
        "session_id": args.session_id or os.getenv("DEVIN_SESSION_ID"),
        "parent_session_id": args.parent_session_id,
        "started_at": as_iso(args.started_at),
        "finished_at": as_iso(args.finished_at),
        "duration_seconds": args.duration,
        "acus_consumed": args.acus,
        # An orchestrator cannot read its own final ACU total: it is still running when it writes
        # the row. Marking the value a lower bound stops a dashboard presenting it as exact.
        "acus_are_floor": args.acus_are_floor,
        "verdict": args.verdict,
        "verdict_reason": args.verdict_reason,
        "counts": as_json(args.counts, "--counts"),
        "tickets": as_json(args.tickets, "--tickets"),
        "report_ids": args.report_ids or None,
        "notes": args.notes,
    }
    extra = as_json(args.extra, "--extra")
    if extra:
        payload["extra"] = extra
    return {key: value for key, value in payload.items() if value is not None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--appname", required=True)
    parser.add_argument("--stage", required=True, help="pr-analysis | heartbeat | impact | functional | performance | final | orchestrator")
    parser.add_argument("--status", required=True, choices=STATUSES)
    parser.add_argument("--pr-id")
    parser.add_argument("--run-id", help="Same value for every stage of one chain, or the totals cannot be grouped")
    parser.add_argument("--repository")
    parser.add_argument("--commit")
    parser.add_argument("--environment")
    parser.add_argument("--playbook-id")
    parser.add_argument("--session-id")
    parser.add_argument("--parent-session-id")
    parser.add_argument("--started-at", help="Epoch seconds or ISO-8601")
    parser.add_argument("--finished-at", help="Epoch seconds or ISO-8601; defaults to now")
    parser.add_argument("--duration", type=float, help="Seconds; derived from the timestamps when omitted")
    parser.add_argument("--acus", type=float)
    parser.add_argument("--acus-are-floor", action="store_true", help="The ACU figure is a lower bound, not the total")
    parser.add_argument("--verdict")
    parser.add_argument("--verdict-reason")
    parser.add_argument("--counts", help='JSON object, e.g. {"executed":26,"passed":22,"failed":4}')
    parser.add_argument("--tickets", help='JSON object, e.g. {"VIT0016231":"passed"}')
    parser.add_argument("--report-ids", nargs="*", help="CRaaS document ids this stage published")
    parser.add_argument("--notes")
    parser.add_argument("--extra", help="JSON object merged into the row")
    parser.add_argument("--endpoint", default=os.getenv("AGENT_LOG_API", DEFAULT_ENDPOINT))
    parser.add_argument("--strict", action="store_true", help="Exit non-zero if the row could not be written")
    parser.add_argument("--dry-run", action="store_true", help="Print the row without sending it")
    args = parser.parse_args()

    payload = build_payload(args)

    if not payload.get("run_id"):
        print("agent_log: no --run-id and no PRQE_RUN_ID; this row cannot be grouped with its "
              "chain and the API will date-stamp it instead", file=sys.stderr)

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    try:
        response = post(args.endpoint, payload)
    except RuntimeError as error:
        print(f"agent_log: write failed, the stage itself is unaffected: {error}", file=sys.stderr)
        return 1 if args.strict else 0

    print(f"agent_log: wrote {response.get('id', '(no id returned)')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
