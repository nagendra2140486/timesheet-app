#!/usr/bin/env python3
"""Post-deploy availability gate.

Verifies a deployed environment is actually serving before functional or performance
suites run, so their failures mean "the code is wrong" rather than "the deploy is broken".

Every check is declared in `heartbeat-expectations.json` beside this file, so the same script
runs against any application: copy the folder, rewrite the expectations, change nothing here.

Read-only by default: no declared request may mutate data, so the suites that follow start from
a clean baseline. Standard library only, so it runs anywhere Python 3.10+ exists.

    python3 devin/tools/heartbeat.py \
        --backend-url https://qa-api.example.com \
        --frontend-url https://qa.example.com \
        --run-id craas-1234 --out-dir reports/craas-1234

Exit codes: 0 healthy (warnings allowed), 1 one or more checks failed, 2 never became ready.
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
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

DEFAULT_EXPECTATIONS = Path(__file__).parent / "heartbeat-expectations.json"

Status = Literal["pass", "fail", "warn", "skip"]

SECRET_FIELD = re.compile(r'"(\w*(?:api_?key|secret|token|password))"\s*:\s*"', re.IGNORECASE)


@dataclass
class Check:
    name: str
    category: str
    status: Status
    detail: str
    latency_ms: int | None = None
    url: str | None = None


@dataclass
class Response:
    status: int
    body: bytes
    headers: dict[str, str]
    latency_ms: int
    error: str | None = None

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except (json.JSONDecodeError, ValueError):
            return {}


def fetch(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 15.0,
) -> Response:
    request = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            elapsed = int((time.perf_counter() - started) * 1000)
            return Response(response.status, payload, {k.lower(): v for k, v in response.headers.items()}, elapsed)
    except urllib.error.HTTPError as error:
        elapsed = int((time.perf_counter() - started) * 1000)
        return Response(error.code, error.read(), {k.lower(): v for k, v in error.headers.items()}, elapsed)
    except Exception as error:  # noqa: BLE001 - any transport failure is a check failure, not a crash
        elapsed = int((time.perf_counter() - started) * 1000)
        return Response(0, b"", {}, elapsed, error=f"{type(error).__name__}: {error}")


def dig(payload: Any, path: str) -> Any:
    """Read a dotted path out of a decoded JSON body, returning None rather than raising."""
    for part in path.split("."):
        if not isinstance(payload, dict) or part not in payload:
            return None
        payload = payload[part]
    return payload


class AssetParser(HTMLParser):
    """Collects script/stylesheet URLs so a deploy with mismatched asset hashes is caught."""

    def __init__(self) -> None:
        super().__init__()
        self.assets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "script" and attributes.get("src"):
            self.assets.append(attributes["src"])
        if tag == "link" and attributes.get("rel") in {"stylesheet", "modulepreload"} and attributes.get("href"):
            self.assets.append(attributes["href"])


@dataclass
class Heartbeat:
    expectations: dict[str, Any]
    urls: dict[str, str]
    commit: str | None = None
    expected: dict[str, str] = field(default_factory=dict)
    budget_ms: int = 2000
    checks: list[Check] = field(default_factory=list)

    # -- recording ---------------------------------------------------------------------

    def record(
        self,
        name: str,
        category: str,
        ok: bool,
        detail: str,
        latency_ms: int | None = None,
        url: str | None = None,
    ) -> bool:
        status: Status = "pass" if ok else "fail"
        # A response that is correct but over budget is degradation, not an outage: the
        # distinction is what stops a slow environment from being reported as down.
        if ok and latency_ms is not None and latency_ms > self.budget_ms:
            status = "warn"
            detail = f"{detail} (over {self.budget_ms}ms budget)"
        self.checks.append(Check(name, category, status, detail, latency_ms, url))
        return ok

    def skip(self, name: str, category: str, reason: str) -> None:
        self.checks.append(Check(name, category, "skip", reason))

    def base(self, service: str) -> str | None:
        return self.urls.get(service)

    # -- phases ------------------------------------------------------------------------

    def wait_until_ready(self, deadline_seconds: int) -> bool:
        """Containers are often still warming right after a deploy; poll before judging."""
        targets = {
            name: f"{self.base(name)}{spec['health']}"
            for name, spec in self.expectations.get("services", {}).items()
            if spec.get("health") and self.base(name)
        }
        if not targets:
            return True

        deadline = time.monotonic() + deadline_seconds
        pending = dict(targets)
        while pending and time.monotonic() < deadline:
            for service, url in list(pending.items()):
                if fetch(url, timeout=5).status == 200:
                    del pending[service]
            if pending:
                time.sleep(3)
        for service, url in targets.items():
            self.record(
                f"{service} reachable",
                "readiness",
                service not in pending,
                "responded to health path" if service not in pending else f"no 200 within {deadline_seconds}s",
                url=url,
            )
        return not pending

    def check_health(self) -> None:
        for name, spec in self.expectations.get("services", {}).items():
            if not spec.get("health") or not self.base(name):
                continue
            url = f"{self.base(name)}{spec['health']}"
            response = fetch(url)
            ok = response.status == 200
            for path, expected in (spec.get("expect_json") or {}).items():
                ok = ok and dig(response.json(), path) == expected
            self.record(f"{name} {spec['health']}", "system", ok, f"HTTP {response.status}", response.latency_ms, url)

    def check_deployed_commit(self) -> None:
        """Without this the gate can smoke-test a stale build and report it green."""
        spec = next(
            ((name, s) for name, s in self.expectations.get("services", {}).items() if s.get("commit_field")),
            None,
        )
        if not self.commit:
            self.skip("deployed commit matches", "system", "no --commit supplied")
            return
        if not spec:
            self.skip("deployed commit matches", "system", "no service declares a commit field")
            return
        name, service = spec
        response = fetch(f"{self.base(name)}{service['health']}")
        deployed = str(dig(response.json(), service["commit_field"]) or "") if response.status == 200 else ""
        if not deployed:
            self.skip("deployed commit matches", "system", "health response does not report a commit")
            return
        matches = deployed.startswith(self.commit[:7]) or self.commit.startswith(deployed[:7])
        self.record("deployed commit matches", "system", matches, f"deployed={deployed} expected={self.commit[:7]}")

    def check_api_surface(self) -> None:
        """Probe the declared endpoints, or derive them from an OpenAPI document if one exists."""
        surface = self.expectations.get("api_surface") or {}
        service = surface.get("service", "backend")
        if not self.base(service):
            return

        for endpoint in surface.get("endpoints", []):
            url = f"{self.base(service)}{endpoint['path']}"
            headers = dict(endpoint.get("headers") or {})
            body = None
            if "json_body" in endpoint:
                # Only for payloads that are rejected before reaching the database: a heartbeat
                # that writes application data corrupts the suites it is meant to gate.
                body = json.dumps(endpoint["json_body"]).encode()
                headers.setdefault("Content-Type", "application/json")
            response = fetch(url, method=endpoint.get("method", "GET"), headers=headers, body=body)
            expected = endpoint.get("expect_status", 200)
            ok = response.status == expected
            for path, value in (endpoint.get("expect_json") or {}).items():
                ok = ok and dig(response.json(), path) == value
            name = endpoint.get("name") or f"{endpoint.get('method', 'GET')} {endpoint['path']}"
            self.record(name, "api", ok, f"HTTP {response.status} (expected {expected})", response.latency_ms, url)

        spec_path = surface.get("from_openapi")
        if not spec_path:
            return
        url = f"{self.base(service)}{spec_path}"
        response = fetch(url)
        if not self.record("openapi spec served", "api", response.status == 200, f"HTTP {response.status}",
                           response.latency_ms, url):
            return
        # Deriving GETs from the spec means a new endpoint is covered the day it ships.
        skip = set(surface.get("skip_paths", [])) | {spec_path}
        paths = [
            path
            for path, operations in (response.json().get("paths") or {}).items()
            if "get" in operations and "{" not in path and path not in skip
        ]
        for path in sorted(paths):
            probe = fetch(f"{self.base(service)}{path}")
            self.record(f"GET {path}", "api", probe.status == 200, f"HTTP {probe.status}", probe.latency_ms, path)

    def check_data_baselines(self) -> None:
        """Functional specs assert exact seed sizes; prove the data before blaming the UI."""
        for baseline in self.expectations.get("data_baselines", []):
            service = baseline.get("service", "backend")
            if not self.base(service):
                continue
            response = fetch(f"{self.base(service)}{baseline['path']}")
            actual = dig(response.json(), baseline.get("field", "count")) if response.status == 200 else None
            self.record(
                baseline.get("name") or f"{baseline['path']} baseline",
                "data",
                actual == baseline["expected"],
                f"expected {baseline['expected']}, found {actual}",
                response.latency_ms,
            )

    def check_configuration(self) -> None:
        for spec in self.expectations.get("config_checks", []):
            service = spec.get("service", "backend")
            if not self.base(service):
                continue
            url = f"{self.base(service)}{spec['path']}"
            response = fetch(url, headers=spec.get("headers"))
            name = spec.get("name") or f"{spec['path']} reachable"
            if not self.record(name, "config", response.status == 200, f"HTTP {response.status}",
                               response.latency_ms, url):
                continue

            payload = response.json()
            for expectation in spec.get("expect", []):
                # Values come from --expect key=value, so the same config serves every environment.
                key = expectation["from_flag"]
                if key not in self.expected:
                    self.skip(expectation["name"], "config", f"no --expect {key}=... supplied")
                    continue
                wanted = self.expected[key]
                actual = dig(payload, expectation["field"])
                if expectation.get("as_bool"):
                    matches = bool(actual) == (wanted.lower() == "true")
                else:
                    matches = str(actual) == wanted
                self.record(expectation["name"], "config", matches, f"expected {wanted}, found {actual}")

            if spec.get("secret_scan"):
                body = response.body.decode("utf-8", "replace")
                # `apiKeyConfigured: false` is intended disclosure — match fields carrying a
                # value, not every field whose name contains "key".
                leaked = SECRET_FIELD.findall(body)
                leaked += [marker for marker in spec.get("secret_markers", []) if marker in body]
                self.record(
                    "no secret in payload",
                    "security",
                    not leaked,
                    f"leaked fields: {leaked}" if leaked else "clean",
                )

    def check_frontend(self) -> None:
        spec = self.expectations.get("frontend") or {}
        base = self.base("frontend")
        if not base or spec.get("enabled") is False:
            return
        response = fetch(base)
        if not self.record("frontend index", "frontend", response.status == 200, f"HTTP {response.status}",
                           response.latency_ms, base):
            return

        if not spec.get("probe_assets", True):
            return
        parser = AssetParser()
        parser.feed(response.body.decode("utf-8", "replace"))
        # A SPA returns 200 for any route, so index.html alone proves nothing; broken or
        # mismatched asset hashes after a deploy are the failure this actually catches.
        for asset in parser.assets[: spec.get("max_assets", 20)]:
            url = urljoin(base + "/", asset)
            probe = fetch(url)
            self.record(f"asset {asset}", "frontend", probe.status == 200, f"HTTP {probe.status}",
                        probe.latency_ms, url)
        if not parser.assets:
            self.skip("frontend assets", "frontend", "index.html references no scripts or stylesheets")

    def check_cors(self) -> None:
        """A CORS origin pointing at the wrong host breaks every browser test downstream."""
        spec = self.expectations.get("cors")
        base = self.base("frontend")
        if not spec or not base:
            return
        service = spec.get("service", "backend")
        origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
        response = fetch(
            f"{self.base(service)}{spec['path']}",
            method="OPTIONS",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
        )
        allowed = response.headers.get("access-control-allow-origin", "")
        self.record(
            "cors allows the frontend origin",
            "config",
            allowed in {origin, "*"},
            f"origin {origin} -> allow-origin '{allowed or 'missing'}'",
            response.latency_ms,
        )

    def run(self, ready_timeout: int) -> None:
        if not self.wait_until_ready(ready_timeout):
            return
        self.check_health()
        self.check_deployed_commit()
        self.check_api_surface()
        self.check_data_baselines()
        self.check_configuration()
        self.check_frontend()
        self.check_cors()


def summarise(checks: list[Check]) -> dict[str, int]:
    return {status: sum(1 for check in checks if check.status == status) for status in ("pass", "fail", "warn", "skip")}


def to_markdown(report: dict[str, Any]) -> str:
    counts = report["summary"]
    icon = {"pass": "PASS", "fail": "FAIL", "warn": "WARN", "skip": "SKIP"}
    lines = [
        f"# Heartbeat Report — {report['appname']}",
        "",
        "| | |",
        "| --- | --- |",
        f"| Run id | `{report['runId']}` |",
        f"| Verdict | **{report['verdict'].upper()}** |",
        f"| Environment | {report['environment'] or 'unspecified'} |",
    ]
    lines += [f"| {service} | {url} |" for service, url in report["urls"].items()]
    lines += [
        f"| Checks | {counts['pass']} passed · {counts['fail']} failed · {counts['warn']} slow · "
        f"{counts['skip']} skipped |",
        f"| Duration | {report['durationMs']} ms |",
        f"| Timestamp | {report['createdAt']} |",
        "",
    ]

    failures = [check for check in report["checks"] if check["status"] == "fail"]
    if failures:
        lines += ["## Failures", "", "| Check | Detail |", "| --- | --- |"]
        lines += [f"| {check['name']} | {check['detail']} |" for check in failures]
        lines.append("")

    lines += ["## All checks", "", "| Result | Category | Check | Detail | Latency |", "| --- | --- | --- | --- | --- |"]
    for check in report["checks"]:
        latency = f"{check['latencyMs']} ms" if check["latencyMs"] is not None else "—"
        lines.append(f"| {icon[check['status']]} | {check['category']} | {check['name']} | {check['detail']} | {latency} |")

    if report["verdict"] == "healthy":
        lines += ["", "Environment is serving; downstream suites may run."]
    else:
        lines += [
            "",
            "**Environment is not healthy.** Treat downstream functional or performance failures as",
            "environment problems until these checks pass.",
        ]
    return "\n".join(lines) + "\n"


def to_junit(report: dict[str, Any]) -> bytes:
    counts = report["summary"]
    suite = ET.Element(
        "testsuite",
        name="heartbeat",
        tests=str(len(report["checks"])),
        failures=str(counts["fail"]),
        skipped=str(counts["skip"]),
        time=f"{report['durationMs'] / 1000:.3f}",
    )
    for check in report["checks"]:
        case = ET.SubElement(suite, "testcase", classname=f"heartbeat.{check['category']}", name=check["name"])
        if check["status"] == "fail":
            ET.SubElement(case, "failure", message=check["detail"]).text = check["detail"]
        elif check["status"] == "skip":
            ET.SubElement(case, "skipped", message=check["detail"])
        elif check["status"] == "warn":
            ET.SubElement(case, "system-out").text = f"WARN: {check['detail']}"
    return ET.tostring(ET.ElementTree(suite).getroot(), encoding="utf-8", xml_declaration=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend-url")
    parser.add_argument("--frontend-url")
    parser.add_argument("--ai-url", help="Only needed when the expectations declare an ai-service")
    parser.add_argument("--expectations", type=Path, default=DEFAULT_EXPECTATIONS)
    parser.add_argument("--run-id", default="local")
    parser.add_argument("--appname", default=os.environ.get("CRAAS_APPNAME"))
    parser.add_argument("--environment")
    parser.add_argument("--commit", help="Expected deployed commit; compared against the health payload")
    parser.add_argument(
        "--expect",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Value for a config expectation declared in the expectations file, e.g. provider=mock",
    )
    parser.add_argument("--ready-timeout", type=int, default=90, help="Seconds to wait for health after a deploy")
    parser.add_argument("--budget-ms", type=int)
    parser.add_argument("--strict", action="store_true", help="Treat slow responses as failures")
    parser.add_argument("--out-dir", default="reports/heartbeat")
    args = parser.parse_args(argv)

    if not args.expectations.is_file():
        parser.error(f"expectations file not found: {args.expectations}")
    args.expectations_data = json.loads(args.expectations.read_text())

    declared = args.expectations_data.get("services", {})
    urls = {"backend": args.backend_url, "frontend": args.frontend_url, "ai-service": args.ai_url}
    missing = [name for name in declared if not urls.get(name)]
    if args.expectations_data.get("frontend", {}).get("enabled", True) and not args.frontend_url:
        missing.append("frontend")
    if missing:
        parser.error(f"missing target URLs for: {', '.join(sorted(set(missing)))}")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    started = time.perf_counter()
    expectations = args.expectations_data

    urls = {
        name: url.rstrip("/")
        for name, url in (("backend", args.backend_url), ("frontend", args.frontend_url), ("ai-service", args.ai_url))
        if url
    }
    expected: dict[str, str] = {}
    for pair in args.expect:
        key, _, value = pair.partition("=")
        expected[key] = value

    heartbeat = Heartbeat(
        expectations=expectations,
        urls=urls,
        commit=args.commit,
        expected=expected,
        budget_ms=args.budget_ms or expectations.get("latency_budget_ms", 2000),
    )
    heartbeat.run(args.ready_timeout)

    counts = summarise(heartbeat.checks)
    unhealthy = counts["fail"] > 0 or (args.strict and counts["warn"] > 0)
    report = {
        "schemaVersion": 2,
        "runId": args.run_id,
        "appname": args.appname or expectations.get("app", "unknown"),
        "environment": args.environment,
        "commit": args.commit,
        "verdict": "unhealthy" if unhealthy else "healthy",
        "urls": urls,
        "summary": counts,
        "durationMs": int((time.perf_counter() - started) * 1000),
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "checks": [
            {
                "name": check.name,
                "category": check.category,
                "status": check.status,
                "detail": check.detail,
                "latencyMs": check.latency_ms,
                "url": check.url,
            }
            for check in heartbeat.checks
        ],
    }

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "heartbeat.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "heartbeat.md").write_text(to_markdown(report))
    (out_dir / "heartbeat-junit.xml").write_bytes(to_junit(report))

    print(to_markdown(report))
    print(f"wrote {out_dir}/heartbeat.{{json,md}} and heartbeat-junit.xml")

    # A distinct code for "never came up", so a caller can retry a deploy rather than
    # treating it as a functional regression.
    if any(check.category == "readiness" and check.status == "fail" for check in heartbeat.checks):
        return 2
    return 1 if unhealthy else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
