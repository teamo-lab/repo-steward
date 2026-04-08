#!/usr/bin/env python3
"""Deliver a PR review to GitHub (hard requirement) and Feishu (soft, degrades).

Usage:
    send_review.py <pr_number> <review_markdown_file>

Hard contract:
    - GitHub comment MUST land or the script exits non-zero.
    - Feishu is best-effort. If any precondition is missing, the script
      still exits 0, prints a gentle HINT block to stderr telling the
      user what they could configure next time.
    - Hints are phrased as "if you tell me X next time, I'll Y" — low
      pressure, actionable, never nagging.

Config lookup order (first match wins):
    1. $TEAMO_PR_NOTIFY_CONFIG
    2. <skill dir>/config.json
    3. ~/.config/teamo/pr-review-notify.json

Environment (for Feishu; all optional):
    FEISHU_APP_ID, FEISHU_APP_SECRET
    Also read from ~/.teamo-env/.env if present (via python-dotenv, if installed).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parent
HINTS: list[str] = []


def hint(msg: str) -> None:
    """Queue a gentle hint for the end-of-run summary."""
    HINTS.append(msg)


def load_env_file() -> None:
    """Best-effort: load ~/.teamo-env/.env so FEISHU_* picks up."""
    env_path = Path.home() / ".teamo-env" / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(env_path)
        return
    except ImportError:
        pass
    # Tiny fallback parser so we don't hard-require python-dotenv.
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), val)


def load_config() -> dict[str, Any]:
    """Return the first config found, or {} if none."""
    candidates: list[Path] = []
    env_override = os.environ.get("TEAMO_PR_NOTIFY_CONFIG")
    if env_override:
        candidates.append(Path(env_override).expanduser())
    candidates.append(SKILL_DIR / "config.json")
    candidates.append(Path.home() / ".config" / "teamo" / "pr-review-notify.json")
    for p in candidates:
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                print(
                    f"⚠️  Config at {p} is not valid JSON ({e}); ignoring.",
                    file=sys.stderr,
                )
    return {}


def run(cmd: list[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        check=check,
        capture_output=capture,
        text=True,
    )


def gh_pr_metadata(pr_number: str) -> dict[str, Any]:
    """Fetch PR metadata via gh. Hard failure if gh is missing/unauthed."""
    try:
        proc = run(
            [
                "gh",
                "pr",
                "view",
                pr_number,
                "--json",
                "number,title,author,url,baseRefName,headRefName",
            ],
        )
    except FileNotFoundError:
        print("❌ `gh` CLI is not installed. Install it and re-run.", file=sys.stderr)
        sys.exit(2)
    except subprocess.CalledProcessError as e:
        print("❌ `gh pr view` failed:", file=sys.stderr)
        print(e.stderr or e.stdout, file=sys.stderr)
        sys.exit(2)
    return json.loads(proc.stdout)


def current_repo_slug() -> str | None:
    """Return owner/repo of the current checkout, or None if not resolvable."""
    try:
        proc = run(["gh", "repo", "view", "--json", "nameWithOwner"])
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    try:
        return json.loads(proc.stdout).get("nameWithOwner")
    except json.JSONDecodeError:
        return None


def post_github_comment(pr_number: str, body_file: Path) -> str:
    """Post the review as a PR comment. Return the comment URL.

    This is the HARD requirement. Any failure here exits non-zero.
    """
    try:
        proc = run(
            ["gh", "pr", "comment", pr_number, "--body-file", str(body_file)],
        )
    except subprocess.CalledProcessError as e:
        print("❌ `gh pr comment` failed — GitHub review did not land.", file=sys.stderr)
        print(e.stderr or e.stdout, file=sys.stderr)
        sys.exit(1)
    url = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    return url


def try_feishu_send(
    *,
    pr_number: str,
    pr_url: str,
    author_login: str,
    repo_slug: str | None,
    review_body: str,
    config: dict[str, Any],
) -> tuple[bool, str]:
    """Attempt to deliver the review to Feishu. Always returns (sent, reason).

    Missing preconditions queue hints via `hint()` and return (False, reason).
    """
    app_id = os.environ.get("FEISHU_APP_ID")
    app_secret = os.environ.get("FEISHU_APP_SECRET")
    if not app_id or not app_secret:
        hint(
            "You don't have Feishu configured in this shell. If you export\n"
            "    FEISHU_APP_ID and FEISHU_APP_SECRET (or drop them into\n"
            "    ~/.teamo-env/.env), I'll also ping the team chat next time."
        )
        return False, "no FEISHU_APP_ID/SECRET in env"

    if not config:
        hint(
            "I couldn't find a pr-review-notify config file. If you create one\n"
            f"    at {SKILL_DIR / 'config.json'} (see config.example.json in the\n"
            "    same directory), I'll know which chat and which teammate to\n"
            "    @-mention. Schema: projects[].repo + chat_id, members[].github\n"
            "    + open_id."
        )
        return False, "no config file found"

    # Find project entry for this repo.
    projects = config.get("projects") or []
    project_entry: dict[str, Any] | None = None
    if repo_slug:
        for p in projects:
            if p.get("repo") == repo_slug:
                project_entry = p
                break
    if project_entry is None:
        hint(
            f"I don't have a Feishu chat mapping for {repo_slug or 'this repo'}.\n"
            "    Tell me something like \"<owner>/<repo> goes to the Teamo Code group\"\n"
            "    (or add an entry under `projects` in config.json with repo +\n"
            "    chat_id) and I'll route there next time."
        )
        return False, f"no project mapping for {repo_slug}"

    chat_id = project_entry.get("chat_id")
    chat_name = project_entry.get("chat_name") or chat_id
    if not chat_id:
        hint(
            f"The config entry for {repo_slug} is missing a chat_id. Add the\n"
            "    Feishu chat_id (starts with `oc_`) under `projects[].chat_id`\n"
            "    and I'll route messages there."
        )
        return False, "project entry missing chat_id"

    # Find author entry.
    members = config.get("members") or []
    author_entry: dict[str, Any] | None = None
    for m in members:
        if m.get("github") == author_login:
            author_entry = m
            break
    if author_entry is None:
        hint(
            f"I don't know @{author_login}'s Feishu identity. If you add them\n"
            "    under `members` in config.json (github + open_id + display_name),\n"
            "    I'll @-mention them in the chat instead of posting silently."
        )
        # We can still send the message without the @mention — decide to do so
        # so the team at least sees it.
        author_entry = {}

    open_id = author_entry.get("open_id")
    display_name = author_entry.get("display_name") or author_login

    try:
        import httpx  # type: ignore
    except ImportError:
        hint(
            "Feishu delivery needs the `httpx` Python package. Install with\n"
            "    `pip3 install httpx` and I'll be able to send to Feishu."
        )
        return False, "httpx not installed"

    base = "https://open.feishu.cn/open-apis"
    try:
        tok_resp = httpx.post(
            f"{base}/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
            timeout=15.0,
        )
        tok_data = tok_resp.json()
    except Exception as e:  # noqa: BLE001 — we want to degrade on any network error
        hint(
            f"Feishu auth failed ({e}). The GitHub comment already landed,\n"
            "    so nothing is blocked. If this keeps happening, check\n"
            "    FEISHU_APP_ID/SECRET values and network reachability."
        )
        return False, f"tenant_access_token error: {e}"

    if tok_data.get("code") != 0:
        hint(
            f"Feishu returned code {tok_data.get('code')}: {tok_data.get('msg')}.\n"
            "    The GitHub comment already landed. Double-check that the\n"
            "    Feishu app is published and the app_secret is current."
        )
        return False, f"token error {tok_data.get('code')}"

    token = tok_data.get("tenant_access_token")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }

    mention = (
        f'<at user_id="{open_id}">@{display_name}</at> '
        if open_id
        else f"@{display_name} (no Feishu id yet) "
    )
    header_line = (
        f"{mention}PR #{pr_number} 的 code review 来了，详见下；PR 链接：{pr_url}\n\n"
        f"(同步在 PR 下留了 comment，两边上下文等价。)\n\n"
        f"————————————————\n\n"
    )
    text_content = header_line + review_body

    payload = {
        "receive_id": chat_id,
        "msg_type": "text",
        "content": json.dumps({"text": text_content}, ensure_ascii=False),
    }

    try:
        resp = httpx.post(
            f"{base}/im/v1/messages?receive_id_type=chat_id",
            headers=headers,
            json=payload,
            timeout=30.0,
        )
        data = resp.json()
    except Exception as e:  # noqa: BLE001
        hint(
            f"Feishu send failed ({e}). GitHub comment already landed;\n"
            "    no action required — the author will still see the review."
        )
        return False, f"send error: {e}"

    if data.get("code") != 0:
        code = data.get("code")
        msg = data.get("msg")
        extra = ""
        if code == 230002:
            extra = (
                "\n    (230002 = bot isn't in the target chat yet. Add the bot\n"
                "    to the chat once and future sends will work.)"
            )
        hint(
            f"Feishu rejected the send: code={code} msg={msg}.{extra}\n"
            "    GitHub comment already landed — nothing lost."
        )
        return False, f"send rejected {code}"

    if not open_id:
        # We sent, but without the @mention.
        return True, f"sent to {chat_name} (no @mention — author open_id missing)"
    return True, f"sent to {chat_name} with @{display_name}"


def print_hints() -> None:
    if not HINTS:
        return
    print("", file=sys.stderr)
    print(
        "🔔 Heads up — a few things I could do next time if you set them up:",
        file=sys.stderr,
    )
    print("", file=sys.stderr)
    for h in HINTS:
        print(f"  • {h}", file=sys.stderr)
        print("", file=sys.stderr)
    print(
        "None of this is required — the GitHub comment already landed.",
        file=sys.stderr,
    )


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 64

    pr_number = argv[1]
    review_file = Path(argv[2]).expanduser()
    if not review_file.exists():
        print(f"❌ Review file not found: {review_file}", file=sys.stderr)
        return 2
    review_body = review_file.read_text(encoding="utf-8")

    load_env_file()
    config = load_config()

    meta = gh_pr_metadata(pr_number)
    author_login = (meta.get("author") or {}).get("login", "")
    pr_url = meta.get("url", "")
    pr_title = meta.get("title", "")
    repo_slug = current_repo_slug()

    print(f"→ Posting review to GitHub PR #{pr_number} ({pr_title})...")
    comment_url = post_github_comment(pr_number, review_file)
    print(f"✅ GitHub comment posted: {comment_url or '(no URL returned)'}")

    print("→ Attempting Feishu delivery...")
    sent, reason = try_feishu_send(
        pr_number=pr_number,
        pr_url=pr_url,
        author_login=author_login,
        repo_slug=repo_slug,
        review_body=review_body,
        config=config,
    )
    if sent:
        print(f"✅ Feishu: {reason}")
    else:
        print(f"↪  Feishu skipped: {reason}")

    print_hints()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
