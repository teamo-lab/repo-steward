# pr-review-notify

A project-level skill that standardizes the "review a PR and bounce it
back to the author" workflow for Edward (Repo Steward).

When invoked, the skill:

1. Walks you through reading the PR diff and writing a real review
   (grounded in `file:line` references — no hallucinated findings).
2. Posts the review as a GitHub PR comment. **This is the hard
   requirement** — if GitHub fails, the whole run fails.
3. Optionally notifies the team's Feishu group chat with the PR
   author @-mentioned, so their own agent session gets the same
   context as yours.
4. Gracefully degrades: if Feishu isn't configured, or the repo isn't
   mapped to a chat, or the author isn't mapped to a Feishu identity,
   the skill still delivers the GitHub comment and gently tells you
   at the end of the run what you could set up next time.

See `SKILL.md` for the full workflow and the "soft hint" design.

---

## Setup

### 1. Install the dependencies the delivery script uses

```bash
pip3 install httpx python-dotenv
```

`python-dotenv` is optional — the script has a tiny fallback parser —
but it's the cleanest way to pick up `~/.teamo-env/.env`.

### 2. Configure Feishu (optional)

Export these in your shell profile, or drop them into
`~/.teamo-env/.env`:

```bash
export FEISHU_APP_ID=cli_xxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The Feishu bot must already be a member of whichever chat you want to
post to. If it isn't, the send will fail with Feishu error `230002`
and the script will tell you so in its hint block.

### 3. Create a local config file

```bash
cp .claude/skills/pr-review-notify/config.example.json \
   .claude/skills/pr-review-notify/config.json
```

Edit `config.json` to list the repos your team tracks and the Feishu
identities of the teammates who send PRs. Schema:

```json
{
  "projects": [
    { "repo": "owner/name", "chat_id": "oc_xxx", "chat_name": "Pretty Name" }
  ],
  "members": [
    { "github": "github-login", "open_id": "ou_xxx", "display_name": "名字" }
  ]
}
```

The real `config.json` is listed in the repo `.gitignore` so chat IDs
and team member identifiers never leak into the public history. The
example file is safe to commit.

---

## Usage

From inside Claude Code, any of these phrases invokes the skill:

- "review PR 10"
- "打回这个 PR"
- "帮我审一下同事发的 PR"
- "review this PR and tell the team"

Claude will:

1. Read the PR metadata and the relevant files.
2. Write a structured review to `/tmp/pr-<N>-review.md`.
3. Run `python3 .claude/skills/pr-review-notify/send_review.py <N> /tmp/pr-<N>-review.md`.
4. Report the GitHub comment URL, the Feishu delivery status, and
   any gentle hints the script emitted.

You can also invoke the script manually:

```bash
python3 .claude/skills/pr-review-notify/send_review.py 10 /tmp/pr-10-review.md
```

---

## Graceful degradation

| What's missing | What still happens |
|---|---|
| `gh` not installed / not authed | Hard fail with a clear error |
| `FEISHU_APP_ID` / `SECRET` not set | GitHub comment posts, Feishu skipped, hint printed |
| No `config.json` | GitHub comment posts, Feishu skipped, hint printed |
| Repo not in `projects` | GitHub comment posts, Feishu skipped, hint printed |
| Author not in `members` | GitHub comment posts, Feishu message sent without @mention, hint printed |
| Bot not in chat | GitHub comment posts, Feishu errors with 230002, hint printed |

The rule: **GitHub is the source of truth.** Feishu is a convenience
channel on top. You will never lose a review because Feishu is down.

---

## Design notes — the "弱弱提醒" pattern

Every missing precondition is collected throughout the run and
surfaced at the end as a single "🔔 Heads up" block on stderr. Hints
are phrased as "if you tell me X next time, I'll Y" — low pressure,
one-time, actionable.

The skill never nags. If the user has seen a hint once and chosen not
to act on it, the calling agent should honor that preference within
the session instead of repeating the same suggestion.
