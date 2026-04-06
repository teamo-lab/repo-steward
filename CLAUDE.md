# CLAUDE.md — Agent Guide for Edward

> Read this file first when you open this repo in Claude Code (or any
> agent runtime). It tells you **what Edward is**, **how to safely add a
> feature**, and **what never to commit**.

---

## 1. Project snapshot

**Edward** is a proactive repo-maintenance agent. It finds, ranks, and
executes safe maintenance work across tracked repos. Architecturally it
is deliberately tiny:

- ~1.1k LOC across three TypeScript files under `src/edward/`
- Runtime: **Bun ≥ 1.1** (not Node) — do not introduce Node-only APIs
- Zero runtime dependencies — check `package.json`, it lists none
- **In-memory state**, no Postgres/Redis/SQLite
- Shells out to the `claude` CLI binary (`CLAUDE_BIN`) for analysis; it
  is not a fork of any Claude codebase
- HTTP server = `Bun.serve`, **not Fastify/Express**
- CLI = hand-rolled argv parsing, **not commander/yargs**

> **Do not reintroduce frameworks or dependencies without an explicit
> PRD decision.** The "zero-dep, single-file-per-concern" constraint is
> the product, not a mistake.

### File map

```
edward                    bash launcher → exec bun src/edward/main.ts
src/edward/main.ts        CLI entrypoint, dispatches subcommands
src/edward/cli.ts         argv parser + HTTP client to the local server
src/edward/server.ts      Bun.serve dashboard + /api/v1/* endpoints
src/edward/dashboard.html web UI served by server.ts
reports/                  analysis write-ups from previous runs
.env.example              documents all optional env vars
```

### Subcommand surface (today)

```
edward serve [--port N]             start dashboard + API on :8080
edward repos                        list tracked repos
edward repos add owner/repo         verify + add (rejects 404/403/5xx)
edward tasks                        list generated maintenance tasks
edward analyze <repo-id>            run an analysis pass
edward run <task-id>                execute an approved task
```

All ID args accept an 8-char UUID prefix.

### Historical context you must preserve

Edward went through four cuts:

| Version | What shipped |
|---------|--------------|
| v0.1    | First Repo Steward prototype (Fastify + Postgres + Redis). Retired. |
| v0.2    | First rewrite — dashboard server only. |
| v0.3    | Product-flow-first analysis prompt for functional-bug discovery. |
| v0.4    | Current. gh/kubectl-style CLI, `--port` flag, strict `repos add` verification, `GITHUB_TOKEN` auto-detection via `gh auth token`. |

See `reports/v0.2-vs-v0.3-comparison.md` and
`reports/clawschool-v0.3.0-edward.md` for the reasoning behind the
product-flow-first prompt. Read them before touching `server.ts`'s
`ANALYSIS_PROMPT`.

### Known gotchas — do not reintroduce these bugs

1. **Phantom `repos add`**: v0.3 silently accepted any string as a repo.
   Fixed in `server.ts` by requiring a strict `owner/repo` regex **and**
   a successful GitHub API verification (200 OK). 404 → reject with a
   clear error. Do not soften this.
2. **Port-in-use fighting `EDWARD_PORT`**: environment variable was
   ignored by subcommands. Fixed by adding a `--port N` flag on `serve`
   plus a lsof hint in the error. Keep the flag.
3. **Dashboard path**: `DASHBOARD_HTML_PATH` in `server.ts` is computed
   relative to the compiled file. If you move `dashboard.html`, update
   that line too.
4. **CLI version string**: hard-coded in `cli.ts`. Bump it in lockstep
   with `package.json`.
5. **Bash launcher `$SCRIPT_DIR`**: the launcher resolves its own path
   with `readlink -f` / `realpath` fallback. Do not replace with
   `$(dirname "$0")` — that breaks when users symlink `edward` onto
   their `$PATH`.

### Hard "do not" list

- **Do not force-push `edward` or `main`** — they were rewritten once,
  in 2026-04 to scrub third-party vendored source. Any further history
  rewriting needs explicit user approval.
- **Do not commit anything under `.agent-team/`, `sessions/`,
  `node_modules/`, or `dist/`**. All four are `.gitignore`d.
- **Do not vendor third-party source trees** into the repo. Edward
  shells out to binaries; if you need a library, discuss adding it as
  a real dependency first.
- **Do not add a `devDependencies` section** casually. Bun runs the
  `.ts` files directly — there is no build step.
- **Do not introduce frameworks** (Express, Fastify, Commander, Zod,
  Prisma, etc.) without a PRD-backed reason. The zero-dep constraint
  is intentional.
- **Do not weaken the `repos add` verification**.
- **Do not mention "Claude Code" in source files, comments, or commit
  messages.** Historical reasons; if you need to refer to the
  subprocess Edward spawns, call it "the `claude` CLI binary".

---

## 2. Feature development workflow

Edward was built 0→1 using a seven-sprint methodology
(`sprint-1-narrative` through `sprint-7-acceptance`). For **incremental
features**, you run a **scoped subset** of that flow. Skip anything the
feature does not need — the goal is traceability, not ceremony.

### Sprint mapping for incremental work

| Sprint       | 0→1 used it? | Incremental feature                        |
|--------------|--------------|--------------------------------------------|
| 1 Narrative  | ✅            | **Skip.** Only for new products.           |
| 2 Outbound   | ✅            | **Skip.** Only for new products.           |
| 3 PRD        | ✅ full       | **Scoped mini-PRD** — required.            |
| 4 Architecture | ✅ full     | **Delta only** — required if impl touches server contract, new endpoint, state shape, or CLI surface. |
| 5 Test specs | ✅ full       | **Scoped** — required for new endpoints, bug fixes, and behavior changes. |
| 6 Impl       | ✅ full       | **Required.**                              |
| 7 Acceptance | ✅ full       | **Required.** Runs before push.            |

The mini-PRD, architecture delta, and test spec live under
`.agent-team/<feature-slug>/` — **not** in `reports/`, **not** committed.

### Agent Team pattern (Planner / Generator / Evaluator)

We reuse the pattern from
[teamo-runner-agency-test](https://github.com/teamo-lab/teamo-runner-agency-test).
You are the **Lead**. You dispatch three teammate roles via the Claude
Code `Task` tool with `subagent_type: general-purpose` (or specialized
agents if your runtime has them). Teammates hand off state through
files, never through tool-call memory.

| Role      | Responsibility                                                          |
|-----------|-------------------------------------------------------------------------|
| Planner   | Read the user's feature request. Write mini-PRD + Sprint plan.          |
| Generator | Implement the Sprint. Modify `src/edward/*.ts` and verify locally.      |
| Evaluator | Independently verify acceptance criteria. Never edits source.          |

**Coordination rules (non-negotiable):**

- Only one teammate runs at a time. Never parallelize Generator and
  Evaluator on the same feature — Evaluator needs Generator's output.
- Teammates communicate via files in `.agent-team/<feature-slug>/`.
- The Lead reads all status files on every loop iteration before
  dispatching the next teammate.
- If a teammate is blocked, it writes `BLOCKED.md` and returns.

### Working-file layout (gitignored)

```
.agent-team/<feature-slug>/
├── MINI_PRD.md          # Planner — problem, scope, non-goals, success criteria
├── SPRINT_PLAN.md       # Planner — ordered checklist, per-step acceptance
├── DESIGN.md            # Planner — architecture delta (only if needed)
├── TEST_SPEC.md         # Planner — what Evaluator must verify
├── NEXT_STEP.md         # Lead — resumable pointer (updated every loop)
├── EVAL_FEEDBACK.md     # Evaluator — pass/fail per criterion + repro steps
├── DEV_SERVER.md        # Generator — how to run this feature locally
└── BLOCKED.md           # Any teammate — human-only resources needed
```

All files above are `.gitignore`d. **They must never end up in a
commit.** Run `git status` before every commit to confirm.

### Step-by-step loop for a new feature

1. **Create branch** (see `README.md` → "Developing a new feature").
   ```bash
   git fetch origin
   git checkout -b feat/<slug> origin/edward
   mkdir -p .agent-team/<slug>
   ```
2. **Dispatch Planner** — give it the user request, Edward's file map,
   and this CLAUDE.md. It writes `MINI_PRD.md` + `SPRINT_PLAN.md` (+
   `DESIGN.md` if the feature touches the server contract, state shape,
   or CLI surface) + `TEST_SPEC.md`.
3. **Lead reviews the plan** — is the scope minimal? Does it break any
   "Hard do not" rule above? Does it reintroduce a known gotcha? If
   yes, send back to Planner.
4. **Dispatch Generator for Sprint 1** — it reads `SPRINT_PLAN.md`,
   implements, runs local verification (see "Verification recipes"
   below), writes `DEV_SERVER.md`.
5. **Dispatch Evaluator** — it reads `TEST_SPEC.md` and
   `DEV_SERVER.md`, independently tests each acceptance criterion,
   writes `EVAL_FEEDBACK.md` with explicit pass/fail and repro commands
   for every fail.
6. **Lead decides:**
   - All pass → advance to next Sprint → step 4.
   - Any fail → Generator fixes → Evaluator re-tests. Loop.
7. **After the last Sprint**, dispatch Evaluator for a final
   end-to-end pass (see "Acceptance" below).
8. **Lead commits** — only source files (see next section).
9. **Push feature branch** and open a PR against `edward`.

### What to commit

Only these paths are fair game:

- `src/edward/**` (the product)
- `reports/**` (if the feature generates a durable analysis writeup
  worth keeping — use sparingly)
- `package.json`, `.env.example`, `.gitignore`, `edward`, `README.md`,
  `CLAUDE.md` (repo root, only when genuinely modified)

**Never commit:**

- `.agent-team/` (Planner/Generator/Evaluator working files)
- `sessions/` (Claude Code transcripts)
- `node_modules/`, `dist/`, `bun.lockb` (ignored; Bun reruns from `.ts`)
- Any file containing the literal string "Claude Code" — see the Hard
  do-not list.

Pre-commit sanity check:

```bash
git status
git diff --cached --stat
# product surface must not mention the upstream agent tool by name:
git grep -i "claude code" -- src/ edward package.json README.md \
  && echo "❌ blocked — scrub product surface" \
  || echo "✅ clean"
```

(CLAUDE.md itself legitimately references "Claude Code" because this
document guides agents running inside Claude Code. The rule applies to
the product surface — `src/`, the launcher, `package.json`, and the
public README — not to this agent guide.)

### Commit message conventions

Follow the pattern of existing commits:

```
feat(edward): <short imperative summary>

<why this change is necessary — the product reason, not the mechanics>
<what the user-visible behavior is now>
<any new or changed env vars, flags, or subcommands>
```

Use `feat:` for new capabilities, `fix:` for bugs, `docs:` for README
or CLAUDE.md updates, `chore:` for dotfiles / gitignore / tooling. Do
not co-author commits to any agent or model — keep them authored
locally.

---

## 3. Verification recipes (Generator + Evaluator use these)

Edward has **no automated test suite today**. Every change is verified
by running the real server and poking it with curl / the CLI itself.
If your Sprint adds a testable unit, write a tiny Bun test in a sibling
`*.test.ts` file and run with `bun test`.

### Start a dev server on a non-conflicting port

```bash
./edward serve --port 8099
# in another terminal:
export EDWARD_URL=http://localhost:8099
```

### Smoke test the full happy path

```bash
./edward repos                              # empty list
./edward repos add teamo-lab/repo-steward   # real public repo, should succeed
./edward repos                              # now one entry
./edward analyze <repo-id-prefix>           # kicks off claude subprocess
./edward tasks                              # tasks appear after analysis
```

### Negative tests for the strict verifier

```bash
./edward repos add not-a-real-user-xyz/totally-fake-repo   # must reject (404)
./edward repos add bad_format                               # must reject (regex)
./edward repos add "; rm -rf /"                             # must reject
```

### Port-in-use check

```bash
./edward serve --port 8099 &
./edward serve --port 8099                  # must fail fast with lsof hint
kill %1
```

### Kill a stuck server

```bash
lsof -iTCP:8099 -sTCP:LISTEN -P -n
kill <pid>
```

### Inspect a session transcript (for traceability)

Claude Code stores per-project sessions under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. If you want
downstream teammates to pick up where you left off, copy the relevant
`.jsonl` into `sessions/` in this repo (gitignored by default).

---

## 4. Acceptance (Sprint 7, scoped)

Before the Lead commits and pushes, the Evaluator runs:

1. All criteria from `TEST_SPEC.md` — pass/fail table in
   `EVAL_FEEDBACK.md`.
2. The full smoke test above — unchanged behavior for untouched
   subcommands.
3. `git status` — confirms nothing under `.agent-team/` or `sessions/`
   is staged.
4. `git grep -i "claude code" -- src/ edward package.json README.md`
   — must return nothing. (CLAUDE.md is excluded: it legitimately
   names the host agent runtime.)
5. `bun src/edward/main.ts --version` — version matches `package.json`.

If any step fails, send back to Generator. **Do not push partially.**

---

## 5. Branch + push workflow

See `README.md` → "Developing a new feature". Short version:

```bash
git fetch origin
git checkout -b feat/<slug> origin/edward
# ...Planner → Generator → Evaluator loop...
git add src/edward/... package.json ...   # explicit paths, never -A
git commit -m "feat(edward): ..."
git push -u origin feat/<slug>
gh pr create --base edward --title "feat: ..." --body "..."
```

**Never** run `git add -A` / `git add .` — the `.gitignore` should
catch the working files, but explicit adds are the second safety net.

**Never** force-push `edward` or `main`. Feature branches are yours.

---

## 6. Resuming a feature across sessions

If your session ends mid-Sprint:

1. Ensure `.agent-team/<slug>/NEXT_STEP.md` is up to date before
   exiting. It is the resume pointer.
2. On the next session, read `NEXT_STEP.md`, `SPRINT_PLAN.md`,
   `EVAL_FEEDBACK.md`, and `BLOCKED.md` in that order before
   dispatching anyone.
3. If a previous teammate was in the middle of edits, check
   `git status` — uncommitted changes belong to the last Generator
   run and should be either accepted or reverted before the next
   dispatch.

---

## 7. When in doubt

- Read the source. It's 1.1k lines. Reading beats guessing.
- Reread this file. The "Hard do not" list is where most regressions
  come from.
- If the user-facing behavior is ambiguous, ask the human user. Do not
  invent requirements.
- Prefer the smallest possible diff. Edward's value is its smallness.
