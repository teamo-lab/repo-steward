---
name: pr-review-notify
description: |
  Review a GitHub PR, post findings as a comment on the PR, AND (if configured)
  notify the PR author in the team's Feishu group chat with an @-mention so
  their own agent session has the same context. Use when the user asks to
  "review a PR", "review PR #N", "打回 PR", "give feedback on a PR",
  "审一下同事的 PR", "review 同事发的 PR", or similar. Gracefully degrades
  when Feishu is not configured — always posts the GitHub comment at minimum.
---

# pr-review-notify

Standardizes the "review a PR and bounce it back to the author" workflow so
you never forget to notify the right channel or leave a dangling review in
your own scratch buffer.

The skill has three hard guarantees:

1. **A real code review gets written.** You still do the work — reading the
   diff, forming opinions, writing the findings. This skill does not
   hallucinate reviews.
2. **GitHub always gets the comment.** The PR is the source of truth; the
   review must land there.
3. **Feishu gets notified when possible.** If the environment is configured
   and the PR author is mapped, the team's group chat also gets a message
   with the author @-mentioned. If any precondition is missing, the skill
   gently tells the user what to configure next time.

---

## When to invoke this skill

User intents that should trigger it:

- "review PR 10"
- "打回这个 PR"
- "帮我审一下同事发的 PR"
- "review this PR and tell the team"
- "review 同事的 PR 并通知到群里"

Do NOT invoke for:

- Self-review of your own in-progress code (no PR exists yet)
- Pre-landing checks (use the existing `review` skill for that)
- Writing a PR description from scratch

---

## Workflow (follow this order)

### Step 1 — Understand the PR

```bash
gh pr view <N> --json number,title,author,url,baseRefName,headRefName,files,additions,deletions,body
git fetch origin <headRefName>
git diff --stat origin/<baseRefName>...origin/<headRefName>
```

If the `files` list in the gh output is suspiciously short relative to the
additions/deletions numbers, fall back to `git diff --name-only` because
`gh pr view --json files` has a known truncation bug on large PRs.

### Step 2 — Read what matters

Don't try to read every file. Prioritize:
- Files directly named in the PR title / body as the main change
- New files (they ship without safety-net review)
- Files with the highest additions count
- Any file that touches `server.ts`, the prompt, the HTTP contract, the DB
  schema, or the CLI surface

Form opinions grounded in concrete file:line references.

### Step 3 — Write the review to a temp file

Save to `/tmp/pr-<N>-review.md`. Structure:

```markdown
## PR #<N> Review — <one-line topic>

**结论**: merge / don't merge / needs changes — 一句话说清楚

---

### 🔴 阻塞 #1 — <title>
**位置**: `path/to/file.ts:42`
**症状**: <user-facing observable>
**原因**: <why>
**建议 fix**: <concrete>

### 🟡 #N — <title>
...

---

### 附带观察（非阻塞）
...
```

Lead with the conclusion. Use 🔴 for blockers, 🟡 for non-blocking issues,
✅ for things you checked and approve of. Always reference file:line.
Always propose a fix direction — don't just point at problems.

### Step 4 — Run the delivery script

```bash
python3 .claude/skills/pr-review-notify/send_review.py <N> /tmp/pr-<N>-review.md
```

The script will:
1. Post the review as a GitHub PR comment (hard requirement, fails loudly)
2. Try to send a Feishu group message with the author @-mentioned (soft,
   degrades gracefully)
3. Print any "heads up" hints at the end (see "Soft hints" below)

### Step 5 — Surface the results to the user

When the script finishes, report to the user:

- The GitHub comment URL (always)
- The Feishu delivery status (sent / skipped + reason)
- **Any "heads up" hints the script printed — pass them through, don't
  swallow them.** These hints are the skill's way of telling the user
  "next time you can get more, here's how". Show them verbatim or
  paraphrase gently, but never suppress.

---

## Soft hints (the "弱弱提醒" design)

If the script ends with Feishu skipped for any reason, it prints a
`HINT` block to stderr that you MUST forward to the user in your final
response. The hints are phrased as "if you tell me X next time, I'll Y"
— low-pressure, one-time, actionable.

Example hint block from the script:

```
🔔 Heads up — a few things I could do next time if you set them up:

  • You don't have Feishu configured in this shell. If you export
    FEISHU_APP_ID and FEISHU_APP_SECRET, I'll also ping the team chat.

  • Even with Feishu configured, I don't know which chat belongs to
    "teamo-lab/repo-steward". Tell me something like "teamo-lab/repo-steward
    goes to the Teamo Code group" (or drop a chat_id into
    .claude/skills/pr-review-notify/config.json) and I'll route there
    next time.

  • I don't know @shufanli's Feishu identity. If you tell me their name
    or open_id, I'll @-mention them instead of just posting silently.

None of this is required — the GitHub comment already landed.
```

When passing this to the user, keep the gentle tone. Do NOT turn it into
a demand list. Do NOT nag on subsequent runs once the user has said "not
now" — remember that preference within the current session and honor it.

---

## Graceful degradation contract

| Failure | What happens | Hint shown? |
|---|---|---|
| `gh` missing / not authed | Abort with clear error | No — this is a hard error, not a hint |
| No Feishu env vars | GitHub comment still posts; Feishu skipped | Yes |
| Config file missing | GitHub comment still posts; Feishu skipped | Yes — explain config paths + schema |
| Repo has no mapping | GitHub comment still posts; Feishu skipped | Yes — offer to add mapping |
| Author has no mapping | GitHub comment still posts; Feishu skipped | Yes — offer to add mapping |
| Author not in chat | Feishu message still sent; logs warning | Yes — warn, don't block |
| Feishu API 4xx/5xx | Feishu skipped; GitHub comment already landed | Yes — show API error |

The rule: **GitHub comment is the only hard requirement**. Everything else
degrades to a hint.

---

## Configuration

Config lookup order (first match wins):

1. `$TEAMO_PR_NOTIFY_CONFIG` env var → path to a JSON file
2. `.claude/skills/pr-review-notify/config.json` (next to this SKILL.md)
3. `~/.config/teamo/pr-review-notify.json`

Schema is documented in `config.example.json` in this directory. The real
`config.json` is gitignored so team data never leaks into the repo.

Required environment variables for Feishu:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

Both are read by the script only — you don't need to export them into
Claude Code's environment.

---

## Known limitations

- Only sends text messages. Markdown structure from the review file
  survives as plaintext (headers show as `##`, bullets as `-`) — the
  GitHub comment has the rich version anyway.
- Chat-membership check uses `tenant_access_token`, which can only list
  members of chats the bot is already in. If the bot isn't in the chat,
  the skill warns and still sends, but the send will fail with 230002
  from Feishu — add the bot to the chat first.
- `gh pr view --json files` is used for the PR metadata only; actual
  diff inspection is your job via `git diff`.
