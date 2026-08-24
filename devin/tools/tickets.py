"""Extract ticket ids from a PR's commits and map each ticket to the files it touched.

Ids are matched by pattern (`VIT` + digits) rather than by position, because CRaaS writes them
inconsistently: `fix(VIT0015739): ...` in some repos, `fix(security): VIT0016042 - ...` in others.
A commit with no matching id contributes its files to `_untracked`, which is what makes a later
failure attributable to "no ticket" rather than silently to the nearest one.
"""

import argparse
import json
import re
import subprocess
from collections import defaultdict

TICKET_RE = re.compile(r"\bVIT\d{5,}\b")


def git(*args: str, cwd: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    merge_base = git("merge-base", args.base, args.head, cwd=args.repo).strip()
    # %x1f/%x1e keep subject and body separable even when a body contains newlines.
    raw = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", f"{merge_base}..{args.head}", cwd=args.repo)

    tickets: dict[str, dict] = defaultdict(lambda: {"commits": [], "files": set()})
    commits = []
    for entry in [e for e in raw.split("\x1e") if e.strip()]:
        sha, subject, body = entry.strip().split("\x1f")
        files = [f for f in git("show", "--pretty=", "--name-only", sha, cwd=args.repo).split("\n") if f]
        found = TICKET_RE.findall(f"{subject}\n{body}")
        ids = sorted(set(found)) or ["_untracked"]
        commits.append({"sha": sha[:7], "subject": subject, "tickets": ids, "files": files})
        for tid in ids:
            tickets[tid]["commits"].append(sha[:7])
            tickets[tid]["files"].update(files)

    out = {
        "merge_base": merge_base[:7],
        "head": git("rev-parse", "--short", args.head, cwd=args.repo).strip(),
        "commits": commits,
        "tickets": {t: {"commits": v["commits"], "files": sorted(v["files"])} for t, v in sorted(tickets.items())},
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=2)

    for tid, v in out["tickets"].items():
        print(f"{tid}: {len(v['commits'])} commit(s), {len(v['files'])} file(s) -> {', '.join(v['files'])}")


if __name__ == "__main__":
    main()
