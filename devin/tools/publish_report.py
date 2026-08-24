#!/usr/bin/env python3
"""Publishes a markdown report to the CRaaS PR QE Impact API (Cosmos DB).

Every playbook stage ends by calling this, so the payload shape and the report-type
vocabulary live in one place instead of in six hand-written curl commands.

    python3 devin/tools/publish_report.py \
        --reporttype heartbeat-report --pr-id 12 --file reports/craas-1234/heartbeat.md

A non-zero exit means the report was not stored; treat that as a stage failure rather
than continuing, since the API validates on write and a rejected document is simply lost.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ENDPOINT = "https://prqe-impact-api-frdubhcxh0aubjdz.canadacentral-01.azurewebsites.net/prqe-analysis"

# Enforced server-side; listed here so a wrong value fails locally instead of as a 422.
REPORT_TYPES = (
    "prqe-analysis",
    "impact-analysis",
    "regression-report",
    "perf-report",
    "a11y-report",
    "failure-analysis",
    "verdict-report",
    "heartbeat-report",
)


# The verdict block the final-analysis stage appends to its markdown.
VERDICT_BLOCK = re.compile(r"<!--\s*prqe-verdict\s*-->\s*```json\s*(\{.*?\})\s*```", re.S)


def extract_verdict(markdown: str) -> dict:
    """Return the report's own verdict block, so structured data survives without a second flag."""
    match = VERDICT_BLOCK.search(markdown)
    if not match:
        return {}
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as error:
        print(f"warning: verdict block is not valid JSON ({error}); publishing empty analysis_json", file=sys.stderr)
        return {}


def publish(endpoint: str, payload: dict, timeout: float = 30.0, attempts: int = 3) -> dict:
    """POST the document, retrying 5xx: the Cosmos write path returns intermittent 500s."""
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode(),
            headers={"accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            # 4xx is the document being wrong; retrying cannot help.
            if error.code < 500 or attempt == attempts:
                raise
            print(f"publish attempt {attempt} failed with HTTP {error.code}; retrying", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", required=True, type=Path, help="Markdown report to publish")
    parser.add_argument("--reporttype", required=True, help=f"One of: {', '.join(REPORT_TYPES)}")
    parser.add_argument("--pr-id", required=True)
    # No app or repository default: this script is copied between repositories, and a stale
    # default would file one app's reports under another's document id.
    parser.add_argument("--appname", default=os.environ.get("CRAAS_APPNAME"), required="CRAAS_APPNAME" not in os.environ)
    parser.add_argument("--repository", default=os.environ.get("CRAAS_REPOSITORY"), required="CRAAS_REPOSITORY" not in os.environ)
    parser.add_argument("--endpoint", default=os.environ.get("CRAAS_API_URL", DEFAULT_ENDPOINT))
    parser.add_argument(
        "--json-file",
        type=Path,
        help="Structured verdict for analysis_json; defaults to the report's own <!-- prqe-verdict --> block",
    )
    args = parser.parse_args(argv)

    if args.reporttype not in REPORT_TYPES:
        print(f"unknown reporttype '{args.reporttype}'; expected one of {', '.join(REPORT_TYPES)}", file=sys.stderr)
        return 2
    if not args.file.is_file():
        print(f"report not found: {args.file}", file=sys.stderr)
        return 2

    markdown = args.file.read_text()
    if args.json_file:
        if not args.json_file.is_file():
            print(f"json not found: {args.json_file}", file=sys.stderr)
            return 2
        analysis_json = json.loads(args.json_file.read_text())
    else:
        analysis_json = extract_verdict(markdown)

    payload = {
        "appname": args.appname,
        "reporttype": args.reporttype,
        "repository": args.repository,
        "pr_id": str(args.pr_id),
        "analysis_markdown": markdown,
        # Required by the API. Stages with nothing structured to say send {} rather than omitting it.
        "analysis_json": analysis_json,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    try:
        result = publish(args.endpoint, payload)
    except urllib.error.HTTPError as error:
        print(f"publish failed: HTTP {error.code} {error.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - the caller only needs the failure, not a traceback
        print(f"publish failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1

    print(f"published {args.reporttype} for pr {args.pr_id}: {result.get('id', result)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
