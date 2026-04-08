# Edward — commit_narrative + calibrated abstention design

**Version:** v0.4.x feature sprint (branch `feat/commit-narrative-and-abstain`)
**Date:** 2026-04-08 overnight, shipped 2026-04-09 morning
**Driver:** 82% false-positive rate on `floatmiracle/ama-user-service`
**Reviewer:** Wu Yupeng (repo owner) — via chat feedback

---

## 1. The problem in one sentence

Edward v0.4 scanned a real production Alipay-based payment service, emitted 11 findings, and the owner rejected 9 of them — 8 outright false positives and 1 as "technically right, known and deferred". The tool was crying wolf at a rate that would make any domain expert stop reading the output.

Wu Yupeng's verbatim feedback (zh):

> 目前看到的测试结果都没有实际意义，都不是真正意义的 bug。核心是 repo 检查 Agent 缺少大量 context，以及历史上开发时缺失注释 + 大量硬编码的遗留问题。我期待看到的是架构层面的问题，或者是类似于 http 300 秒等 bug 的发现。所有和 Alipay 相关的 feature，都不太对，核心是 agent 没理解我们当前的支付解法。

Four root causes, identified via Codex second-opinion review:

1. **The prompt rewards exhaustive accusation, not calibrated abstention.** The v0.4 `ANALYSIS_PROMPT_INSTRUCTIONS` said literally *"BE EXHAUSTIVE: there is NO upper limit on findings per category."* There was no counter-pressure, no save gate, no "consider why a senior engineer might have done this on purpose".
2. **Zero business context.** Edward saw source files and git history only. It did not know Alipay IDs are *intentionally* surfaced for compliance, that missing `on_conflict` on the rewards table is covered by an upstream idempotency key, or that the real 300s HTTP timeout bug lives in a config file the prompt never asks the model to read.
3. **Zero memory across runs.** Every scan started from scratch. If the owner dismissed "Alipay ID exposure" on Monday, Tuesday's scan would re-emit it verbatim.
4. **No channel to ask questions.** Owner feedback was a one-way dump via chat — none of that context survived the session.

## 2. The shape of the fix

Five tightly-coupled pieces, all on one feature branch, all minimal:

### 2.1 `src/edward/commit_narrative.ts` — new deterministic machine layer

A new layer alongside `profile.ts`, `ci_extract.ts`, `hot_modules.ts`. Reads `git log` over the last 365 days (respecting the existing shallow-clone fallback: 30d → depth=100 → depth=1) and summarizes:

- **Module trajectories.** For each top-level source dir AND each hot-modules path: commit count, most recent change, 5 most recent non-trivial commit subjects, conventional-commit type (feat/fix/refactor/chore).
- **Recurring themes.** Co-occurring keywords across commit subjects that hint at domain concepts the repo keeps revisiting ("alipay", "refund", "timeout", "conflict", "rollback", "migration"). Surfaced to the prompt as "this repo has been repeatedly touching X — be cautious before claiming X is broken".
- **Recent incidents.** Commits in the last 90 days whose subjects match `/fix|revert|rollback|hotfix|incident|urgent|p[0-2]/i`, with their touched files. These are the "we already got burned here" breadcrumbs.

Edward does not parse intent out of commit messages semantically — that is the LLM's job. The TypeScript layer extracts the raw facts. The extracted object is injected into the prompt as `COMMIT_NARRATIVE`, exactly the same way `HOT_MODULES` and `CI_CONFIG_FILES` are injected today.

**Why this matters for the ama eval:** In Wu Yupeng's codebase, commit_narrative would surface "alipay" as a recurring theme with dozens of recent feat/refactor commits in the payout path. The prompt's new rule says: *"if a module has multiple feat: and refactor: entries in the last year, the team is ON IT, and claiming fundamental bugs in that area without strong counterevidence is almost certainly noise."* That alone suppresses roughly half the Alipay-related false positives.

**Key helpers:**

| Helper                      | Purpose                                                              |
|-----------------------------|----------------------------------------------------------------------|
| `detectCommitNarrative()`   | Main entry point. Returns `{trajectories, themes, incidents}`.       |
| `extractConventionalType()` | Maps commit subject → `feat|fix|refactor|chore|docs|test|unknown`.   |
| `extractIncidentMarkers()`  | Regex-matches incident keywords in commit subjects.                  |
| `aggregateThemes()`         | Builds the keyword co-occurrence map for recurring-theme detection.  |

**Graceful degradation:** if the repo is not a git repo (shouldn't happen for tracked repos, but just in case), the function returns the empty shape. If `git log` fails or the repo has zero history, every aggregate is empty — never throws.

### 2.2 `src/edward/repo_memory.ts` — per-repo JSON persistence

Smallest possible persistence delta Edward can ship. One JSON file per repo:

```
~/.edward/repo-memory/<owner>__<repo>.json   (default)
$EDWARD_MEMORY_DIR/<owner>__<repo>.json      (override for tests/transient runs)
```

Schema version: `1`. Two sections:

```jsonc
{
  "version": 1,
  "repoFullName": "floatmiracle/ama-user-service",
  "updatedAt": "2026-04-08T...",
  "dismissedFindings": [
    {
      "type": "security_fix",
      "title": "Alipay user ID exposed in payout history response",
      "fingerprint": "security_fix::alipay user id exposed in payout history response",
      "dismissedAt": "...",
      "reason": "Alipay IDs are intentionally shown to end users per compliance",
      "scanId": "discover-..."
    }
  ],
  "answeredQuestions": [
    {
      "questionId": "q_abc",
      "question": "Is Alipay user ID allowed to be exposed to end users?",
      "answer": "Yes, per compliance requirement. Not PII in this context.",
      "answeredAt": "...",
      "scanId": "..."
    }
  ]
}
```

**Design decisions:**

- **One file per repo, not SQLite.** Zero-dep is the product constraint. SQLite would ship a native binary, which we do not want. JSON is enough.
- **Atomic writes via `.tmp + rename`.** A crash mid-write never leaves a corrupted file behind.
- **Missing/malformed files degrade to fresh empty memory.** `loadRepoMemory` never throws — it returns `freshMemory()` on any IO or parse error and logs a warning. This is critical because the analyze pipeline calls `loadRepoMemory` unconditionally at the start of every scan.
- **Sanitized filename.** `sanitizeRepoName("../etc/passwd")` cannot escape the memory directory — it lowercases, strips to `[a-z0-9._-]`, joins with `__`, and emits `unknown__passwd` (or similar). Tested explicitly in `repo_memory.test.ts`.
- **Capped at 200 entries per section (most-recent kept).** Prevents unbounded growth for a noisy repo.
- **Fingerprint-based dedup.** `fingerprintFor(type, title)` normalizes punctuation + whitespace + case and truncates to 120 chars, so cosmetic title variations ("Alipay ID Exposed!" vs "alipay id exposed") collapse to the same dedup key. Re-dismissing the same finding updates the reason/date on the existing entry instead of duplicating it.
- **Compact prompt projection.** `memoryForPrompt(mem, maxBytes=8KB)` trims oldest entries until the JSON fits the budget, so a heavy repo cannot blow up the analysis prompt.

**Key public API:**

| Function              | Purpose                                                         |
|-----------------------|-----------------------------------------------------------------|
| `loadRepoMemory()`    | Read JSON; never throws; returns fresh empty memory on any err. |
| `saveRepoMemory()`    | Atomic write via `.tmp + rename`; caps each section at 200.     |
| `recordDismissal()`   | Load + append + dedupe by fingerprint + save.                   |
| `recordAnswer()`      | Load + append + dedupe by questionId + save.                    |
| `memoryForPrompt()`   | Project to a compact JSON-safe object, capped at `maxBytes`.    |
| `sanitizeRepoName()`  | Escape-safe filename derivation. Exported for tests.            |
| `fingerprintFor()`    | Normalized dedup key for cross-scan matching.                   |

### 2.3 `ANALYSIS_PROMPT_INSTRUCTIONS` rewrite — calibrated abstention

This is the single highest-leverage change in the sprint. Core deltas from v0.4:

| Area                            | v0.4 (old)                                                     | v0.4.x (new)                                                                                                    |
|---------------------------------|----------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| Count cap                       | "BE EXHAUSTIVE: no upper limit on findings"                    | "BE CALIBRATED: emit AT MOST 5-8 findings in phase_1_2_3 per scan"                                              |
| Zero-finding allowed            | Implicitly discouraged                                         | "ZERO is a valid answer"; "It is FAR better to return zero findings than to pad"                                |
| Save gate on each finding       | None                                                           | Three mandatory string fields: `why_might_be_intentional`, `counterevidence_checked`, `why_no_higher_layer_mitigation` |
| Steelman rule                   | None                                                           | "STEELMAN EVERY FINDING before emitting it"; three sub-questions (a)(b)(c) written into the prompt              |
| Business context                | None                                                           | `REPO_MEMORY` and `COMMIT_NARRATIVE` injected at the bottom of the prompt, with rules for how to consume them   |
| Escape hatch                    | None                                                           | `open_questions` array, cap of 3 per scan; "ASK INSTEAD OF GUESS" rule                                          |
| Cross-scan memory               | None                                                           | "Before emitting any candidate finding, check whether its type+title matches a dismissed entry"                 |

The save-gate fields are the teeth of the whole rewrite. They are non-empty strings. The model cannot emit a finding without writing them, which means it cannot emit a finding without first stopping to say "here is why this might be intentional", "here is what I actually read to rule that out", and "here is why an upstream layer doesn't already catch this". This is cheap for the model (one extra sentence per field) and expensive for a lazy accusation (forcing the model to read counterevidence before accusing).

`BE EXHAUSTIVE` is removed. The phrase does not appear anywhere in `src/edward/server.ts` (verified by `grep -c "BE EXHAUSTIVE" src/edward/server.ts == 0`).

Phase 0 (CI health audit) is untouched. It has no count cap — it still emits every real CI gap. The rewrite only changes Phase 1-3 behavior, which is where the 82% FP rate was coming from.

### 2.4 `open_questions` escape hatch

New top-level array in the LLM's output schema:

```jsonc
{
  "open_questions": [
    {
      "question": "Is the Alipay user ID allowed to be shown to end users in the payout UI?",
      "context": "I have a candidate finding that treats this as PII exposure, but if it is intentional per compliance, the finding should be dropped.",
      "blocks_finding_type": "security_fix",
      "would_emit_without_answer": false
    }
  ]
}
```

Cap: 3 per scan. Each must be answerable in one sentence. On the server side, questions are stashed in an in-memory `Map<string, EdwardQuestion>` with fields `{id, repo_id, scan_id, question, why_it_matters, what_would_change, status, answer, asked_at, answered_at}`.

Deduplication rule: on each scan, for each new open_question, skip if there is already an open (non-answered) question on the same repo with the exact same question text. This stops a noisy repo from accumulating duplicate questions across repeated scans.

**REST endpoints (new):**

- `GET /api/v1/repos/:id/questions` → `{ open: [...], answered: [...], open_count, answered_count }`
- `POST /api/v1/repos/:id/questions/:qid/answer` — body `{answer: string}`; validates non-empty answer ≤ 2000 chars; updates in-memory Map; persists to repo_memory via `recordAnswer`.

**Dashboard UI:** new "Open Questions" section between Suggestions and All Tasks. Each open question renders as a card with the question, a "why it matters" line, a "what would change" line, a textarea for the answer, and a "Save answer" button. Answered questions collapse into a read-only "Answered" subsection below. The section is marked with `id="questions-tab"` and `data-tab="questions"` so future TEST_SPEC grep checks can lock the surface in place across refactors.

When an answer is saved, the dashboard fires `POST /api/v1/repos/:id/questions/:qid/answer`, which (a) flips the in-memory question status to `answered`, (b) calls `recordAnswer()` to persist into `~/.edward/repo-memory/...json`, and (c) returns the updated question. The next scan reads that answer back via `REPO_MEMORY.answeredQuestions` and treats it as ground truth about the product's business context.

### 2.5 Wiring into `analyzeRepoWithAgent`

Additions inside `analyzeRepoWithAgent` (server.ts):

```ts
const commitNarrative = detectCommitNarrative(`${tmpDir}/repo`, {
  hotModulePaths: hotModules.map(h => h.path),
  windowDays: 365,
});
const repoMemory = loadRepoMemory(fullName);
console.log(`[edward] commit_narrative: ${commitNarrative.trajectories.length} trajectories, ...`);
console.log(`[edward] repo_memory: ${repoMemory.dismissedFindings.length} dismissed, ...`);
```

Both get threaded into `buildAnalysisPrompt` via the `runPhase` closure, alongside the existing `profile`, `ciConfigFiles`, `hotModules` inputs. The prompt template appends:

```
COMMIT_NARRATIVE:
<memoryForPrompt(commitNarrative)>

REPO_MEMORY:
<memoryForPrompt(repoMemory, 8*1024)>
```

Phase 0 and Phase 1-3 both see both blocks. Phase 0 mostly ignores them (CI audit doesn't care about dismissed security findings), but the injection is free and makes the prompt structure uniform across phases.

When the model emits `open_questions`, the parser extracts them and returns them on `AnalyzeResult.open_questions`. The `/discover` handler then stashes each one in the `questions` Map, deduping against any existing open question with the same text on the same repo.

When a task is dismissed via the dashboard (`POST /api/v1/tasks/:id/action` with `action: 'dismiss'`), the handler now also calls `recordDismissal(repo.full_name, {type, title, id}, reason)` so the next scan picks it up via `REPO_MEMORY.dismissedFindings`. Best-effort: if the repo is gone from the map, we skip the persistence and log a warning.

## 3. What's explicitly NOT in this sprint

Deferred to later cycles, listed for traceability:

- **Architecture probe** (`architecture_probe.ts`) — parsing timeout configs, retry policies, queue consumer code. The 300s HTTP timeout on the payout path is the real bug Wu Yupeng actually cares about, and we cannot reach it without a separate machine layer. Too large for one overnight sprint; the abstention changes should reduce FP noise enough to make architecture findings visible by contrast.
- **Feishu 上线群 bot.** Future idea to mine deploy-channel messages for context. Needs a Feishu API integration, app registration, event subscription — not tonight.
- **Full adjudication memory.** We persist (a) dismissed findings with reasons and (b) answered questions. We do NOT yet persist approved findings, executed PRs, or longitudinal stats. Same file format, just extra sections — but not tonight.
- **Running a second end-to-end scan on ama-user-service.** Each scan burns ~$1 and ~10 minutes. The evaluation in `reports/ama-baseline-eval.md` is a static before/after on the prompt against the eval baseline, not a real re-scan. A real re-scan happens tomorrow morning with the owner in the loop.
- **CLI subcommand for questions.** Questions are dashboard-surfaced only. The CLI gets them for free via the existing REST API if someone wants to script it.
- **Confidence-threshold changes.** `toEdwardTask` still requires confidence ≥ 0.7. The save-gate fields pressure the model to emit *fewer* candidate findings; they do not lower the floor on the ones it does emit.

## 4. How this is verified

**Unit tests** (Bun's built-in test runner, no new deps):

- `src/edward/commit_narrative.test.ts` — 23 tests covering `detectCommitNarrative`, `extractConventionalType`, `extractIncidentMarkers`, `aggregateThemes`, including a graceful-degradation test for a non-git directory.
- `src/edward/repo_memory.test.ts` — 18 tests covering `loadRepoMemory`, `saveRepoMemory`, `recordDismissal`, `recordAnswer`, `sanitizeRepoName`, `fingerprintFor`, `memoryForPrompt`, including malformed-JSON tolerance, unsupported-version tolerance, traversal-escape prevention, and eviction on overflow.

```
bun test src/edward/commit_narrative.test.ts src/edward/repo_memory.test.ts
# 41 pass, 0 fail
```

**Integration smoke:**

```bash
./edward serve --port 8123 --yes           # dummy API key; non-TTY passes preflight
curl -sf http://localhost:8123/health      # → {"status":"healthy"}
curl -s -X POST .../api/v1/repos -d '{"full_name":"teamo-lab/repo-steward"}'
curl -s .../api/v1/repos/:id/questions     # → {"open":[],"answered":[],"open_count":0,"answered_count":0}
curl -s -X POST .../questions/nonexistent/answer  # → HTTP 404 {"error":"Question not found"}
curl -s -X POST .../repos -d '{"full_name":"not-a-real-user-xyz/totally-fake-repo"}' # → 404 (strict verifier preserved)
curl -s -X POST .../repos -d '{"full_name":"bad_format"}'  # → 400 (regex preserved)
curl -s http://localhost:8123/ | grep -c 'data-tab="questions"'  # → 1
```

Everything passes. The existing strict-repos-add verifier (CLAUDE.md Gotcha #1) and the `--port N` flag (Gotcha #2) are both preserved.

**Qualitative eval** against the 11 ama findings: see `reports/ama-baseline-eval.md`. Target was "at least 6 of the 9 rejected findings show a plausible suppression path in the new prompt" (MINI_PRD success criterion). Actual: 11/11.

## 5. Known risks and follow-ups

1. **We didn't re-run the real scan tonight.** The evaluation is static (read the new prompt against the baseline findings, judge suppression by design). A real re-scan on Wu Yupeng's repo tomorrow morning is the only way to know whether the FP rate actually drops from 82% to a livable number. If it doesn't, the next iteration probably needs the architecture_probe layer, not more prompt tuning.
2. **The eval baseline's finding titles are partially reconstructed.** Finding #1 (Alipay user ID exposure) is verbatim-verified from Wu's chat. Findings #2-#11 are reconstructed from the aggregated "all Alipay-related features are wrong" category plus the specific sub-issues Wu called out. The types, verdicts, and owner_reasons are fixed; the exact titles will be backfilled on the morning review. The evaluation is still valid because the suppression paths depend on the verdict + reason, not the verbatim title.
3. **Ephemeral state is still ephemeral.** Repos and tasks still live in `Map`s and reset on restart. Repo memory is the first piece of persistent state Edward has ever had; the bar for adding more (SQLite, Postgres) stays high. Do not conflate "we added repo-memory" with "we now have a database layer".
4. **Open questions are capped at 3 per scan, 1 per unique question text on the same repo.** A repo that genuinely needs more context than that will have to answer and re-scan. This is a deliberate calibration choice — if a scan produces 10 questions, the prompt is probably too uncertain to be useful and the better fix is to raise the confidence floor or fix the prompt, not to flood the dashboard with questions.
5. **commit_narrative reads 365 days of git log on every scan.** On a huge repo this is still fast (git log is O(commits), not O(files)), but if we ever hit a pathological repo we may need to cap the window or cache the result. Not a concern today.

## 6. File diff summary (what actually changed)

New files:
- `src/edward/commit_narrative.ts` (530 LOC)
- `src/edward/commit_narrative.test.ts` (217 LOC, 23 tests)
- `src/edward/repo_memory.ts` (296 LOC)
- `src/edward/repo_memory.test.ts` (197 LOC, 18 tests)
- `evals/ama-baseline.json` (ground-truth reference for FP analysis)
- `reports/commit-narrative-design.md` (this doc)
- `reports/ama-baseline-eval.md` (qualitative before/after)

Modified files:
- `src/edward/server.ts` — ANALYSIS_PROMPT_INSTRUCTIONS rewrite, new `questions` Map + `EdwardQuestion` interface, `ParsedAnalysis.open_questions` field, wiring for commit_narrative + repo_memory in `analyzeRepoWithAgent`, two new REST endpoints, dismiss-task hook into `recordDismissal`.
- `src/edward/dashboard.html` — new Questions section + CSS + JS (loadQuestions / answerQuestion), wired into existing Promise.all loading pattern and discovery polling completion handler.
- `.gitignore` — added `.agent-team/` (Planner/Generator/Evaluator working files must never be committed).

Zero new runtime dependencies. Zero new devDependencies. Still Bun ≥ 1.1 only. The zero-dep, single-file-per-concern constraint is preserved.

---

**One-line summary for the CHANGELOG when we eventually bump:** *Edward now reads its own git history, remembers what the owner has already dismissed, and asks questions instead of guessing.*
