#!/usr/bin/env python3
"""Publish the WENZL books profile to the /wenzl/ page's engine.

Reads the profile JSON exported by qb_report.py (the QuickBooks reader in
~/.openclaw/workspace/quickbooks/), sends it to the private engine with the
books key, then reads it straight back to verify the publish actually took —
never trust a claim of done without evidence.

The honesty guard from the exporter holds here too: a profile whose meta says
simulated (practice-company numbers) is refused unless --practice is given,
and even then the page will wear its yellow PRACTICE banner.

Usage:
  python3 scripts/publish_books.py <profile.json> [--practice]

Keys: secrets/books.env in founder-os (BOOKS_TOKEN, BOOKS_URL) — never in
this repo.
"""
import json
import sys
import urllib.request
from pathlib import Path

ENV_PATH = Path.home() / "workspace" / "founder-os" / "secrets" / "books.env"


def load_env() -> dict:
    if not ENV_PATH.exists():
        raise SystemExit(f"No key file at {ENV_PATH} — run setup-board.command first.")
    env = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    for k in ("BOOKS_TOKEN", "BOOKS_URL"):
        if not env.get(k):
            raise SystemExit(f"{k} missing/empty in {ENV_PATH} — run setup-board.command.")
    return env


def call(url: str, payload: dict | None = None) -> dict:
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode())


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    practice_ok = "--practice" in argv
    if len(args) != 1:
        print(__doc__.strip())
        return 2

    profile_path = Path(args[0]).expanduser()
    profile = json.loads(profile_path.read_text())
    meta = profile.get("meta") or {}
    if meta.get("simulated") and not practice_ok:
        raise SystemExit(
            "REFUSING to publish: this profile is PRACTICE data "
            f"(source: {meta.get('source')}). Use --practice to publish it anyway — "
            "the page will label it loudly."
        )

    env = load_env()
    url, token = env["BOOKS_URL"], env["BOOKS_TOKEN"]

    put = call(url, {
        "token": token, "action": "books-put",
        "source": f"publish_books.py <- {profile_path.name}",
        "profile": profile,
    })
    if not put.get("ok"):
        raise SystemExit(f"Engine refused the publish: {put}")

    back = call(f"{url}?token={token}&action=books")
    got = back.get("profile") or {}
    if got.get("meta", {}).get("generated") != meta.get("generated"):
        raise SystemExit("Published, but the read-back doesn't match — investigate before trusting the page.")

    print(f"Published and verified: {put.get('bytes')} bytes, updated {put.get('updated')}")
    print(f"  source    : {meta.get('source')}  ({meta.get('company')})")
    print(f"  simulated : {meta.get('simulated')}")
    print("  the page at bandpeace.com/wenzl/ now serves exactly this profile")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
