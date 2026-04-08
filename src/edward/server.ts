/**
 * Edward Dashboard Server — lightweight HTTP server for Repo Steward UI.
 * Shells out to the `claude` CLI binary (CLAUDE_BIN) to run agent analyses.
 *
 * Uses Bun's native HTTP server (no Fastify needed in the edward build).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { detectRepoProfile, type RepoProfile } from './profile.js';
import { extractCIRawConfig, type CIRawConfig } from './ci_extract.js';
import { detectHotModules, type HotModule } from './hot_modules.js';
import { invokeLLMWithFallback, isProvider, type Provider } from './llm_provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, 'dashboard.html');

// In-memory store (no Postgres required for edward standalone mode)
interface EdwardRepo {
  id: string;
  github_id: number;
  owner: string;
  name: string;
  full_name: string;
  installation_id: string;
  default_branch: string;
  language: string;
  is_active: boolean;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface EdwardTask {
  id: string;
  repo_id: string;
  signal_ids: string[];
  type: string;
  status: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  impact: Record<string, unknown>;
  verification: Record<string, unknown>;
  confidence: number;
  risk_level: string;
  suggested_at: string | null;
  approved_at: string | null;
  completed_at: string | null;
  dismiss_reason: string | null;
  snooze_until: string | null;
  execution_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EdwardExecution {
  id: string;
  task_id: string;
  repo_id: string;
  status: string;
  agent_provider: string;
  branch_name: string;
  pr_url: string | null;
  logs: Array<{ timestamp: string; level: string; message: string }>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// State
const repos: Map<string, EdwardRepo> = new Map();
const tasks: Map<string, EdwardTask> = new Map();
const executions: Map<string, EdwardExecution> = new Map();
let discoveryRunning = false;

function uuid(): string {
  return crypto.randomUUID();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ── Repo add helper (shared by POST handler + seed loader) ──

type AddRepoResult =
  | { ok: true; repo: EdwardRepo; created: boolean }
  | { ok: false; status: number; error: string };

async function addRepoByFullName(fullName: string): Promise<AddRepoResult> {
  // Strict owner/repo validation — prevents path traversal into the GitHub API URL
  // and rejects garbage like "foo/bar/baz" or "/foo" up front.
  if (!fullName || !/^[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9][A-Za-z0-9-_.]*$/.test(fullName)) {
    return { ok: false, status: 400, error: `full_name must match owner/repo (got: ${fullName})` };
  }

  const existing = [...repos.values()].find(r => r.full_name === fullName);
  if (existing) return { ok: true, repo: existing, created: false };

  const [owner, name] = fullName.split('/');

  // Verify the repo actually exists on GitHub before adding it. Without this,
  // typos silently create phantom repos that later fail at clone time.
  const ghHeaders: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'edward',
  };
  if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers: ghHeaders });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Could not reach GitHub to verify repo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 404) return { ok: false, status: 404, error: `Repository not found on GitHub: ${fullName}` };
  if (res.status === 403) return { ok: false, status: 403, error: 'GitHub API rate-limited or forbidden. Set GITHUB_TOKEN to increase the limit.' };
  if (!res.ok) return { ok: false, status: 502, error: `GitHub API returned ${res.status} for ${fullName}` };

  const d = await res.json() as any;
  const repo: EdwardRepo = {
    id: uuid(),
    github_id: d.id,
    owner,
    name,
    full_name: fullName,
    installation_id: '0',
    default_branch: d.default_branch || 'main',
    language: d.language || 'Unknown',
    is_active: true,
    settings: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  repos.set(repo.id, repo);
  return { ok: true, repo, created: true };
}

// ── Seed file: re-add known repos at startup ──
//
// Edward keeps state in memory by design. To avoid the "re-add the same
// repos every restart" tax, an optional ~/.edward/seed.json (overridable
// via EDWARD_SEED_FILE) lists owner/name strings to load at boot.
//
// Schema:    {"repos": ["owner/name", ...]}
// Failures:  individual entries log a warning and are skipped — never crash.
// Loading:   fire-and-forget after Bun.serve binds, so the dashboard URL
//            appears immediately.

async function loadSeedFile(): Promise<void> {
  const home = process.env.HOME || '';
  let seedPath = process.env.EDWARD_SEED_FILE || join(home, '.edward', 'seed.json');
  if (seedPath.startsWith('~/')) seedPath = join(home, seedPath.slice(2));

  if (!existsSync(seedPath)) return;

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(seedPath, 'utf-8'));
  } catch (err: any) {
    console.warn(`[edward] seed: invalid JSON at ${seedPath}: ${err.message}`);
    return;
  }

  const list = parsed?.repos;
  if (!Array.isArray(list)) {
    console.warn(`[edward] seed: ${seedPath} missing "repos" array`);
    return;
  }

  console.log(`[edward] seed: loading ${list.length} repos from ${seedPath}`);
  let ok = 0, fail = 0;
  for (const entry of list) {
    if (typeof entry !== 'string') {
      console.warn(`[edward] seed: skipping non-string entry: ${JSON.stringify(entry)}`);
      fail++;
      continue;
    }
    const result = await addRepoByFullName(entry);
    if (result.ok) {
      ok++;
      console.log(`[edward] seed: + ${entry}${result.created ? '' : ' (already loaded)'}`);
    } else {
      fail++;
      console.warn(`[edward] seed: ✗ ${entry} — ${result.error}`);
    }
  }
  console.log(`[edward] seed: done. ${ok} loaded, ${fail} failed.`);
}

// ── Agent analysis using claude CLI ──

// Resolve the `claude` CLI binary path.
//
// Precedence:
//   1. CLAUDE_BIN env var (explicit override)
//   2. `command -v claude` on the user's PATH
//   3. Common install locations (homebrew, /usr/local, ~/.local, ~/.bun)
//
// Throws a friendly error if none succeed. Callers should catch and
// surface the message — this is the single most common first-run
// failure on a fresh clone.
let cachedClaudeBin: string | null = null;

export function resolveClaudeBin(): string {
  if (cachedClaudeBin) return cachedClaudeBin;

  if (process.env.CLAUDE_BIN) {
    if (!existsSync(process.env.CLAUDE_BIN)) {
      throw new Error(
        `CLAUDE_BIN=${process.env.CLAUDE_BIN} is set but that file does not exist.\n` +
        `       Unset it or point it at a real \`claude\` binary.`
      );
    }
    cachedClaudeBin = process.env.CLAUDE_BIN;
    return cachedClaudeBin;
  }

  // `command -v` resolves PATH lookups without sourcing the user's interactive rc files.
  try {
    const out = execSync('command -v claude 2>/dev/null', {
      shell: '/bin/sh',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out && existsSync(out)) {
      cachedClaudeBin = out;
      return cachedClaudeBin;
    }
  } catch {}

  const home = process.env.HOME || '';
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    `${home}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedClaudeBin = p;
      return cachedClaudeBin;
    }
  }

  throw new Error(
    `Could not find the \`claude\` CLI binary on your PATH.\n` +
    `       Install it and run \`claude\` once to log in, then retry.\n` +
    `       Or set CLAUDE_BIN=/full/path/to/claude if it lives somewhere unusual.`
  );
}

export interface AuthEnvStatus {
  apiKeySet: boolean;
  apiKeyPreview: string | null;
  suggestion: string;
}

/**
 * Describes which auth source the `claude` subprocess will end up using.
 *
 * We only inspect ANTHROPIC_API_KEY. OAuth detection lives inside the
 * `claude` binary itself — Keychain / ~/.claude/.credentials.json paths
 * are cross-platform hostile and not our business. The one thing a user
 * can accidentally leave wrong is a stray ANTHROPIC_API_KEY export in
 * their shell rc file, and that's exactly what this check catches.
 */
export function describeAuthEnv(): AuthEnvStatus {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    return {
      apiKeySet: true,
      apiKeyPreview: key.slice(0, 12) + '…',
      suggestion:
        'ANTHROPIC_API_KEY is set. The `claude` subprocess will bill\n' +
        'analysis runs to that API account and IGNORE any OAuth login\n' +
        'you configured. To use your OAuth login instead:\n' +
        '  unset ANTHROPIC_API_KEY\n' +
        'then relaunch `edward serve`.',
    };
  }
  return {
    apiKeySet: false,
    apiKeyPreview: null,
    suggestion:
      'No ANTHROPIC_API_KEY in environment — the `claude` subprocess\n' +
      'will use its stored OAuth credentials. If you have not logged\n' +
      'in yet, run `claude` once interactively to complete login.',
  };
}

// ── CI Scorecard types ──

export type CIScorecardDimensionKey =
  | 'presence' | 'triggers' | 'build_stage' | 'test_stage' | 'lint_stage'
  | 'security_scan' | 'branch_protection' | 'deployment' | 'hygiene' | 'docs';

export interface CIScorecardDimension {
  score: number;                   // 0-10
  status: 'pass' | 'partial' | 'fail' | 'unverified' | 'na';
  evidence: string[];
  gaps: string[];
}

export interface CIScorecard {
  overall_score: number;           // 0-100
  verdict: 'no_ci' | 'minimal' | 'partial' | 'comprehensive';
  provider: string;
  generated_at: string;
  dimensions: Record<CIScorecardDimensionKey, CIScorecardDimension>;
  top_fixes: Array<{
    title: string;
    effort_min: number;
    impact: 'high' | 'medium' | 'low';
    why: string;
    suggested_change: string;
  }>;
}

const ANALYSIS_PROMPT_INSTRUCTIONS = `You are Repo Steward, a senior product engineer doing a pre-incident review of a real production codebase. Your job is to find PRODUCT-LEVEL risks that a smart human reviewer would care about — not just generic code-health nits.

══════════════════════════════════════
PHASE 0 — CI HEALTH AUDIT (run BEFORE phases 1-3)
══════════════════════════════════════

You will be given two machine-detected inputs at the bottom of this prompt:
- REPO_PROFILE: a JSON object describing topology, roles, stacks, package
  managers, test directories, and detected scripts
- CI_CONFIG_FILES: an array of {path, provider, content} objects with the
  raw text of every CI config file found in the repo

Your job in Phase 0:

STEP A — Build the EXPECTED checklist
Based on REPO_PROFILE, decide what CI checks this kind of repo SHOULD have.
Examples:
- Node frontend → install, lint, typecheck, test, build, dep-vuln-scan
- Python backend with Dockerfile → install, lint, test, container-scan
- Library → install, test, multi-version matrix, publish dry-run
- IaC repo → terraform validate, plan dry-run, security policy check
- Monorepo → per-workspace install/test, optionally affected-only mode
If REPO_PROFILE.roles is empty, infer from README and directory listing.

HARD RULE — no-CI case (CR #5):
If CI_CONFIG_FILES is empty AND the repo contains ANY executable code
(REPO_PROFILE.stacks != ['unknown'] OR REPO_PROFILE.roles non-empty OR
README / Makefile / package.json scripts mention build/test/deploy), you
MUST emit exactly one ci_missing finding with confidence >= 0.9 and
riskLevel = 'high', titled "Repository has no CI configuration at all".
Do NOT skip this even if you cannot confidently derive the full EXPECTED
checklist — the deterministic code layer will also synthesize this task
as a safety net, but emitting it from the model enriches the description
and de-duplicates with the synthetic one by type+title.

STEP B — Extract the ACTUAL CI
Read every entry in CI_CONFIG_FILES. Map each job/step into one of these
buckets: install / lint / typecheck / test / build / security_scan /
deploy / other. Note these quality signals on every job:
- timeouts set?
- dependency / build cache configured?
- pinned action versions (vN vs @main vs sha)?
- continue-on-error abused on critical steps?
- triggers (push, pull_request, tag, schedule, workflow_dispatch)
- matrix coverage when README implies multi-version support

STEP C — DIFF and emit ci_* findings
Compare EXPECTED vs ACTUAL. For each gap, emit a finding with type:
- ci_missing: bucket present in EXPECTED but absent in ACTUAL
- ci_weak: bucket exists but inadequate (e.g., test runs but not gated)
- ci_fake: workflow exists but doesn't actually verify (e.g., test step
  is \`echo 'tests pass'\` or \`|| true\` on critical step)
- ci_governance_gap: missing trigger / missing required check / matrix gap
- ci_insecure: hardcoded secret, overprivileged permissions, pin to @main,
  deprecated action, PR workflow with elevated permissions

userImpact for ci_* findings = what production incident this CI gap would
let through. Be specific.

STEP D — Compute the CIScorecard
Score these 10 dimensions on a 0-10 scale:

  presence            — any CI exists, valid syntax, matches host platform
  triggers            — push/pr/tag/schedule/manual coverage is appropriate
  build_stage         — install + build runs, matrix where appropriate, cached
  test_stage          — tests run on every PR, gated, coverage tracked
  lint_stage          — linter + typecheck present and enforcing
  security_scan       — dependabot/SAST/secret-scan/SBOM coverage
  branch_protection   — required checks on default branch (mark UNVERIFIED
                        in this version — we cannot query GitHub API yet)
  deployment          — CD configured, staged, gated on tests + security
  hygiene             — pinned versions, timeouts, no continue-on-error abuse
  docs                — CI badge in README, CONTRIBUTING references CI

For each dimension: status one of pass/partial/fail/unverified/na.
- Use \`unverified\` for branch_protection in this version
- Use \`na\` when the dimension does not apply (e.g., deployment for a
  pure library repo)

Composite score: weighted sum, weights:
  presence:15, triggers:8, build_stage:12, test_stage:15, lint_stage:8,
  security_scan:18, branch_protection:10, deployment:5, hygiene:5, docs:4
Exclude any \`unverified\` or \`na\` dimension from BOTH numerator and
denominator before normalizing to 0-100.

verdict:
  - no_ci          if CI_CONFIG_FILES is empty
  - minimal        if overall_score < 30
  - partial        if 30 <= overall_score < 70
  - comprehensive  if overall_score >= 70

top_fixes: pick the 3 highest-impact fixes (effort_min should be
realistic — adding dependabot.yml is ~2 minutes, adding a CodeQL
workflow is ~5 minutes, enforcing tsc is ~1 minute).

══════════════════════════════════════
PHASE 1 — UNDERSTAND THE PRODUCT (mandatory before phases 2-3)
══════════════════════════════════════
Before suggesting product bugs, you MUST:
1. Read README.md / README.* / docs/ to learn what this product actually does
2. Identify EVERY user-facing feature you can find — sign-up, login,
   payment, upload, deployment, search, settings, admin actions,
   notifications, billing, exports, integrations, etc. Do not pick a
   top-N subset. Aim for completeness; if you find 12 features list
   all 12.
3. Find the entry points for ALL of them (HTTP routes, CLI commands,
   API endpoints, UI handlers, scheduled jobs, webhooks, queue
   consumers)
4. Trace EVERY critical flow you can identify end-to-end from user
   input → response. A critical flow is anything where a regression
   would cause a user-visible failure or data integrity issue.

If there is no README, use directory structure + main entry files to
infer the product. Use route registries (FastAPI APIRouter, Express
app.use, Next.js pages/api, Go gin.Engine, Rust router::new etc.) to
build a complete entry-point inventory before moving to Phase 2.

══════════════════════════════════════
PHASE 1.5 — MANDATORY HOT-MODULE DEEP-DIVE (run BEFORE Phase 2)
══════════════════════════════════════

You will be given a HOT_MODULES list at the bottom of this prompt
(possibly empty). Each entry is a file path that machine signals
(git change frequency, test coverage, complexity) have flagged as
high-risk for THIS specific repo right now.

For EVERY hot module in the list, you MUST:

1. Read the entire file (or all relevant sections if it is large).
2. Trace every public function / endpoint / handler defined in it
   end-to-end. Follow the data flow into and out of each call.
3. Specifically check the edge cases that hot modules are most
   likely to have:
   - Boundary conditions: scores going DOWN after upgrades, ties,
     negative values, zero, max-int, off-by-one in pagination.
   - Idempotency: what happens if this endpoint / callback is
     called twice with the same input? Lost updates? Double charges?
     Lost points?
   - State machine transitions: can the entity reach a state that
     wasn't explicitly designed for? Stale "expired" → "pending"?
     "completed" before "submitted"?
   - Race conditions: TOCTOU between check and write, missing
     transactions, lost updates under concurrent load.
   - Auth bypass: does the function check authorization on EVERY
     entry point? Including the legacy ones?
   - Input validation: every parameter from outside (HTTP form,
     query string, JSON body, URL path) — what if it's missing,
     wrong type, malicious payload, very long, unicode?
   - Cross-flow leakage: can user A read user B's data through
     this code path?

4. For each issue found, emit a finding in phase_1_2_3_findings
   with userImpact specifying exactly what the user sees.

The hot modules list is the single most reliable signal Edward has
for "where the bugs are most likely to be hiding right now". A
finding missed in a hot module is a much worse failure than missing
something in a cold module — it means a real production bug in code
that everyone has been touching has slipped through anyway.

You may NOT skip a hot module because "it looks fine" or "I already
have enough findings in that area". The list is mandatory and
exhaustive. After you have completed every hot module, then proceed
to Phase 2 free exploration of the rest of the codebase.

══════════════════════════════════════
PHASE 2 — FUNCTIONAL BUG HUNT (priority — most valuable findings)
══════════════════════════════════════
For each critical user flow, look for issues that would cause REAL USER PAIN:

A. **Flow breaks**: Code paths where the happy path works but a realistic edge case silently fails
   - Example: file upload endpoint that doesn't validate MIME type → corrupted user files
   - Example: payment retry logic that double-charges on network blip
   - Example: registration form that accepts duplicate emails because the unique check is on a different field

B. **State / data integrity bugs**: Race conditions, missing transactions, off-by-one in pagination, stale cache
   - Example: token refresh that has TOCTOU between check-expired and use
   - Example: counter increment without atomic update → lost updates under load

C. **User-visible failure modes**: Where errors leak to the user, where loading states never end, where retries go forever
   - Example: 500 with stack trace shown to user
   - Example: form submit button stays disabled after API error
   - Example: silent failure when external API returns 200 with error in body

D. **Compatibility / deployment risks**: Installation paths that fail on real user environments
   - Example: skill installer assumes Linux paths but spec says cross-platform
   - Example: download URL hardcoded to a CDN that gets rate-limited
   - Example: config file expected at one path but written to another

E. **Behavior contradicting docs**: Where README/docs promise X but the code does Y
   - Example: doc says "auto-saves every 30s" but timer is 60s
   - Example: CLI flag documented but not actually parsed

For EACH functional finding, you must show:
- The actual user-facing symptom (not "bad code")
- The specific code location that causes it
- What the user would experience when it triggers

══════════════════════════════════════
PHASE 3 — CODE HEALTH (secondary — only if highly impactful)
══════════════════════════════════════
After functional bugs, optionally include code-health issues — but ONLY ones with real consequences:
- Security vulns that an attacker could actually exploit (not theoretical)
- Memory leaks / resource leaks visible in production
- Dead code paths that confuse current debugging
- Type errors that mask real bugs

Skip: style nits, missing type annotations, "could be more idiomatic", missing docstrings.

══════════════════════════════════════
RULES
══════════════════════════════════════
- BE PROACTIVE: don't follow bug-fix commits as hints. Find issues that haven't broken yet but will.
- BE CONCRETE: every finding must reference an actual file:line, not "somewhere in the codebase"
- BE PRODUCT-MINDED: prefer 1 functional bug over 10 code-quality nits
- BE HONEST: if the codebase is healthy and you genuinely cannot find
  any high-confidence issue in a category, return zero items for that
  category. Do not invent or pad.
- BE EXHAUSTIVE: there is NO upper limit on findings per category.
  Report every issue you find with confidence ≥ 0.7. If a real
  codebase has 25 high-confidence functional bugs, return 25. Do not
  pick a "top N" subset — silently dropping bugs makes Edward
  non-deterministic across runs and that is the worst possible
  failure mode for a quality-audit tool.
- Each task must be specific enough for another coding agent to fix as a small PR
- All ci_* findings come from Phase 0
- All phase_1_2_3 findings come from Phases 1-3

══════════════════════════════════════
OUTPUT FORMAT (JSON object only, no markdown fence)
══════════════════════════════════════
Return EXACTLY one JSON object with this top-level shape:

{
  "ci_scorecard": { ...CIScorecard schema below... },
  "ci_findings":          [ ...task objects from Phase 0... ],
  "phase_1_2_3_findings": [ ...task objects from Phases 1-3... ]
}

Each task object (in either array) follows this schema:

{
  "type": "<one of the type tokens below>",
  "title": "Short, action-oriented title",
  "description": "2-4 sentences. Lead with the USER-FACING SYMPTOM, then the cause, then the fix direction.",
  "confidence": 0.0-1.0,
  "riskLevel": "low|medium|high",
  "userImpact": "What the user sees when this triggers. Be specific.",
  "evidence": {
    "signals": ["concrete observation 1", "concrete observation 2"],
    "codeSnippets": [{"file": "path/to/file.py", "line": 42, "content": "actual code line"}]
  },
  "impact": {
    "estimatedFiles": ["path/to/file.py"],
    "estimatedLinesChanged": 25,
    "blastRadius": "isolated|module|cross-cutting"
  },
  "verification": {
    "method": "Specific repro: 'Run X with input Y, observe Z'",
    "steps": ["step 1", "step 2"],
    "successCriteria": ["After fix, X should produce Y instead of Z"]
  }
}

Allowed type tokens:
- ci_findings: ci_missing | ci_weak | ci_fake | ci_governance_gap | ci_insecure
- phase_1_2_3_findings: functional_bug | flow_break | ux_gap | compat_risk | doc_drift | security_fix | perf_improvement | dead_code | error_handling | test_gap | code_quality

CIScorecard schema:

{
  "overall_score": 0-100,
  "verdict": "no_ci|minimal|partial|comprehensive",
  "provider": "github_actions|gitlab_ci|circleci|jenkins|azure_pipelines|bitbucket_pipelines|drone|none",
  "generated_at": "<ISO timestamp>",
  "dimensions": {
    "presence":          { "score": 0-10, "status": "...", "evidence": [...], "gaps": [...] },
    "triggers":          { ... },
    "build_stage":       { ... },
    "test_stage":        { ... },
    "lint_stage":        { ... },
    "security_scan":     { ... },
    "branch_protection": { ... },
    "deployment":        { ... },
    "hygiene":           { ... },
    "docs":              { ... }
  },
  "top_fixes": [
    { "title": "...", "effort_min": <int>, "impact": "high|medium|low",
      "why": "...", "suggested_change": "..." }
  ]
}

Confidence threshold: only emit findings with confidence >= 0.7.
There is NO upper bound on the number of findings — emit every
finding that crosses the threshold. Sort by confidence descending
within each category, but do not truncate.

Prioritize Phase 0 (CI gaps) and Phase 2 (functional bugs) when
exploration time is limited, but do not skip categories entirely.

REMINDER: respond with the JSON object only. No prose, no markdown, no code fence.`;

/**
 * Build the per-run prompt by appending machine-detected facts to the
 * static instructions. Keeping the static instructions reviewable by
 * humans is more important than minimizing token count.
 */
function buildAnalysisPrompt(
  profile: RepoProfile,
  ciRaw: CIRawConfig,
  hotModules: HotModule[],
  opts?: { skipProduct?: boolean; skipCI?: boolean }
): string {
  const skipNote = opts?.skipProduct
    ? '\n\nIMPORTANT: Skip Phases 1, 1.5, 2, and 3 entirely. Only run Phase 0 (CI Health Audit). Return ci_scorecard + ci_findings, with phase_1_2_3_findings as an empty array.\n'
    : opts?.skipCI
    ? '\n\nIMPORTANT: Skip Phase 0 (CI Health Audit) entirely. Another parallel run is handling CI. Return ci_findings as an empty array and ci_scorecard as null. Focus all turns on Phases 1, 1.5, 2, and 3 (product understanding, hot-module deep-dive, functional bugs).\n'
    : '';

  // Cap CI files in prompt to keep size manageable. Each file already
  // truncated to 100KB by ci_extract.ts, but on a repo like react with
  // 24 workflows we still need a top-level cap.
  const MAX_CI_FILES_IN_PROMPT = 10;
  const ciFilesForPrompt = ciRaw.configFiles.slice(0, MAX_CI_FILES_IN_PROMPT);
  const ciFilesNote = ciRaw.configFiles.length > MAX_CI_FILES_IN_PROMPT
    ? `\n(Note: ${ciRaw.configFiles.length - MAX_CI_FILES_IN_PROMPT} additional CI files exist but were omitted from the prompt for size. Their paths: ${ciRaw.configFiles.slice(MAX_CI_FILES_IN_PROMPT).map(f => f.path).join(', ')})`
    : '';

  const hotModulesBlock = hotModules.length > 0
    ? `HOT_MODULES (${hotModules.length} files Phase 1.5 MUST deep-inspect):
${JSON.stringify(hotModules, null, 2)}`
    : `HOT_MODULES: []
(no machine signals available — Phase 1.5 has nothing to deep-dive,
proceed directly from Phase 1 to Phase 2.)`;

  return `${ANALYSIS_PROMPT_INSTRUCTIONS}${skipNote}

═══════════════════════════════════════
INPUT — repo facts (machine-detected)
═══════════════════════════════════════

REPO_PROFILE:
${JSON.stringify(profile, null, 2)}

CI_CONFIG_FILES (${ciRaw.configFiles.length} files, primary provider: ${ciRaw.provider}):
${JSON.stringify(ciFilesForPrompt, null, 2)}${ciFilesNote}

${hotModulesBlock}
`;
}

/**
 * Clone a public or private GitHub repo with enough history to compute
 * 30-day change frequency for the hot-module detector.
 *
 * Strategy (in order of preference):
 *   1. --shallow-since="30 days ago" — clone exactly the last 30 days
 *      of commits, regardless of activity level. Active repos get more,
 *      dead repos get less. This is what we actually want.
 *   2. --depth=100 — fallback when shallow-since fails (some git servers
 *      don't support it; happens rarely on github but sometimes on
 *      mirrors). 100 commits is enough for slow-to-moderate repos.
 *   3. --depth=1 — last resort. Hot-module detection degrades to "no
 *      change frequency available" but everything else still works.
 *
 * Auth: GITHUB_TOKEN via Basic header (git smart-HTTP requires Basic,
 * not Bearer; the token never enters URL or git config).
 *
 * Throws on clone failure. Caller's outer try/catch handles cleanup.
 */
function cloneRepoWithToken(fullName: string, dest: string, branch?: string): void {
  const url = `https://github.com/${fullName}.git`;

  const baseArgs: string[] = [];
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    baseArgs.push('-c', `http.extraheader=Authorization: Basic ${basic}`);
  }

  // If caller specified a non-default branch, add `--branch <name>` and
  // `--single-branch` so we only fetch refs we actually need. If not
  // specified, git clones the remote HEAD (default branch) as before.
  const branchArgs: string[] = branch
    ? ['--branch', branch, '--single-branch']
    : [];

  const tryClone = (depthArgs: string[]): { ok: boolean; stderr: string } => {
    const args = [...baseArgs, 'clone', ...branchArgs, ...depthArgs, url, dest];
    const r = spawnSync('git', args, {
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) return { ok: false, stderr: r.error.message };
    if (r.status !== 0) {
      return { ok: false, stderr: (r.stderr?.toString() || '').slice(0, 500) };
    }
    return { ok: true, stderr: '' };
  };

  // Attempt 1: shallow-since 30 days
  let r = tryClone(['--shallow-since=30 days ago']);
  if (r.ok) return;
  console.log(`[edward] shallow-since clone failed, trying depth=100: ${r.stderr.slice(0, 120)}`);

  // Clean up any partial clone before retrying
  try { execSync(`rm -rf ${dest}`, { stdio: 'pipe' }); } catch {}

  // Attempt 2: depth 100
  r = tryClone(['--depth', '100']);
  if (r.ok) return;
  console.log(`[edward] depth=100 clone failed, falling back to depth=1: ${r.stderr.slice(0, 120)}`);

  try { execSync(`rm -rf ${dest}`, { stdio: 'pipe' }); } catch {}

  // Attempt 3: depth 1 (original behavior; hot-module detection will degrade)
  r = tryClone(['--depth', '1']);
  if (r.ok) return;
  throw new Error(`git clone failed all 3 attempts. Last error: ${r.stderr}`);
}

/**
 * Find the first balanced JSON value (`{...}` or `[...]`) starting at
 * the first matching opener in `text`. Walks character by character,
 * tracking string state and escapes so quoted braces / brackets don't
 * fool the depth counter.
 *
 * This replaces the previous regex-based parser, which had two failure
 * modes:
 *   1. Non-greedy code-fence regex truncated at the first nested ``` —
 *      losing every finding when Claude's description embedded a yaml
 *      example.
 *   2. Greedy `\{[\s\S]*\}` over-matched into trailing prose containing
 *      `${{ secrets.X }}` — choking the parser on the trailing garbage.
 *
 * Returns null if no balanced value is found.
 */
function findFirstBalancedJson(text: string, open: '{' | '['): string | null {
  const close = open === '{' ? '}' : ']';
  const startIdx = text.indexOf(open);
  if (startIdx < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/**
 * Convert a raw task object from the LLM output into an EdwardTask.
 * Defensive — every field has a default, never throws on weird shapes.
 */
function toEdwardTask(t: any): EdwardTask | null {
  if (!t || typeof t !== 'object' || !t.title) return null;
  // Confidence threshold raised from 0.65 to 0.7 to cut the "edge"
  // findings that flip on/off across runs (the 0.62-0.68 band was the
  // main source of run-to-run variance).
  if (typeof t.confidence !== 'number' || t.confidence < 0.7) return null;

  return {
    id: uuid(),
    repo_id: '',
    signal_ids: [],
    type: t.type || 'code_quality',
    status: 'suggested',
    title: String(t.title),
    description: String(t.description || '') + (t.userImpact ? `\n\n**User impact:** ${t.userImpact}` : ''),
    evidence: { ...(t.evidence || { signals: [] }), userImpact: t.userImpact },
    impact: t.impact || { estimatedFiles: [], estimatedLinesChanged: 0, blastRadius: 'isolated' },
    verification: t.verification || { method: 'Tests pass', steps: [], successCriteria: [] },
    confidence: Math.min(1, Math.max(0, t.confidence)),
    risk_level: t.riskLevel || 'low',
    suggested_at: new Date().toISOString(),
    approved_at: null,
    completed_at: null,
    dismiss_reason: null,
    snooze_until: null,
    execution_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

interface AnalyzeResult {
  tasks: EdwardTask[];
  scorecard: CIScorecard | null;
}

async function analyzeRepoWithAgent(
  fullName: string,
  opts?: { skipProduct?: boolean; provider?: Provider; allowFallback?: boolean; branch?: string }
): Promise<AnalyzeResult> {
  const tmpDir = `/tmp/edward-${Date.now()}`;

  // Effective provider: explicit flag → env var → default claude.
  const envProvider = process.env.EDWARD_PROVIDER;
  const effectiveProvider: Provider =
    opts?.provider ??
    (envProvider && isProvider(envProvider) ? envProvider : 'claude');

  try {
    // Clone — pass GITHUB_TOKEN via http.extraheader so private repos
    // and rate-limited unauthenticated egress paths actually work.
    // We deliberately do NOT embed the token in the URL.
    cloneRepoWithToken(fullName, `${tmpDir}/repo`, opts?.branch);
    if (opts?.branch) {
      console.log(`[edward] cloned branch: ${opts.branch}`);
    }

    // Layer 1 + 2 + 3: profile, CI extraction, and hot-module detection
    const profile = detectRepoProfile(`${tmpDir}/repo`);
    const ciRaw = extractCIRawConfig(`${tmpDir}/repo`);
    const hotModules = detectHotModules(`${tmpDir}/repo`, { topN: 8 });
    console.log(`[edward] profile: roles=[${profile.roles.join(',')}] stacks=[${profile.stacks.join(',')}] topology=${profile.topology}`);
    console.log(`[edward] ci: provider=${ciRaw.provider} files=${ciRaw.configFiles.length}`);
    if (hotModules.length > 0) {
      console.log(`[edward] hot modules: ${hotModules.map(m => `${m.path}(${m.metrics.changeFreq ?? '?'}c)`).join(', ')}`);
    } else {
      console.log(`[edward] hot modules: none (no git history or coverage data)`);
    }

    // Dispatch through the provider abstraction. invokeLLMWithFallback
    // handles binary resolution, spawn, env scrubbing, error capture,
    // output normalization, AND auto-retry on the other provider if
    // the primary returns a retriable error.
    const allowFallback =
      opts?.allowFallback !== false && process.env.EDWARD_NO_FALLBACK !== '1';
    const baseCfg = {
      provider: effectiveProvider,
      model: effectiveProvider === 'claude' ? 'sonnet' : undefined,
      maxBudgetUsd: 5,
      timeoutMs: 1_200_000,
    };

    // A3 performance fix: split Phase 0 (CI audit, fast, bounded — no
    // repo file reads needed) and Phase 1-3 (product bug hunt, heavy,
    // reads many files) into two parallel LLM calls. Wall time becomes
    // max(phase0, phase123) instead of phase0 + phase123. Phase 0 also
    // gets a tighter turn cap since it operates entirely on the data
    // already inlined in the prompt (REPO_PROFILE + CI_CONFIG_FILES).
    //
    // Respects the original skipProduct / skipCI opts: if the caller
    // asked for only one half, we just run that half sequentially.
    type PhaseResult = {
      label: 'phase0' | 'phase123';
      ok: boolean;
      stdout: string;
      costUsd: number;
      durationMs: number;
      error?: string;
      actualProvider: Provider;
      providersTried?: Provider[];
    };

    const runPhase = async (label: 'phase0' | 'phase123'): Promise<PhaseResult> => {
      const phaseOpts = label === 'phase0'
        ? { skipProduct: true }
        : { skipCI: true };
      const phasePrompt = buildAnalysisPrompt(profile, ciRaw, hotModules, phaseOpts);
      const maxTurns = label === 'phase0' ? 15 : 60;
      const r = await invokeLLMWithFallback(
        phasePrompt,
        `${tmpDir}/repo`,
        { ...baseCfg, maxTurns },
        { allowFallback }
      );
      return {
        label,
        ok: r.ok,
        stdout: r.stdout,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        error: r.error,
        actualProvider: r.provider ?? effectiveProvider,
        providersTried: r.providersTried,
      };
    };

    // Phase 0 always runs. Phase 1-3 runs unless the caller explicitly
    // asked for CI-only (skipProduct=true via `edward ci-audit`).
    const wantPhase0 = true;
    const wantPhase123 = !opts?.skipProduct;

    const phases: Promise<PhaseResult>[] = [];
    if (wantPhase0) phases.push(runPhase('phase0'));
    if (wantPhase123) phases.push(runPhase('phase123'));

    console.log(`[edward] Running ${phases.length} parallel LLM ${phases.length === 1 ? 'call' : 'calls'} (phase0=${wantPhase0}, phase123=${wantPhase123})`);
    const phaseResults = await Promise.all(phases);

    let totalCost = 0;
    let combinedParsed: ParsedAnalysis = { ci_findings: [], phase_1_2_3_findings: [], scorecard: null };
    for (const pr of phaseResults) {
      totalCost += pr.costUsd;
      const triedLabel =
        pr.providersTried && pr.providersTried.length > 1
          ? ` (tried: ${pr.providersTried.join('→')})`
          : '';
      console.log(
        `[edward] ${pr.label} ${pr.actualProvider} response: cost=$${pr.costUsd.toFixed(2)}, ` +
        `duration=${pr.durationMs}ms, ok=${pr.ok}${triedLabel}`
      );
      if (!pr.ok) {
        console.error(`[edward] ${pr.label} ${pr.actualProvider} error: ${pr.error?.slice(0, 500) || '(unknown)'}`);
        continue; // let the other phase still contribute
      }
      console.log(`[edward] ${pr.label} raw preview: ${pr.stdout.slice(0, 200)}...`);
      const phaseParsed = parseAnalysisResult(pr.stdout);
      // Merge: phase0 contributes ci_findings + scorecard; phase123 contributes phase_1_2_3_findings.
      // We accept ci_* output from whichever phase produced it (defensive — if the LLM ignored the
      // split instruction we still capture what it gave us).
      if (phaseParsed.ci_findings.length > 0) {
        combinedParsed.ci_findings.push(...phaseParsed.ci_findings);
      }
      if (phaseParsed.phase_1_2_3_findings.length > 0) {
        combinedParsed.phase_1_2_3_findings.push(...phaseParsed.phase_1_2_3_findings);
      }
      if (phaseParsed.scorecard && !combinedParsed.scorecard) {
        combinedParsed.scorecard = phaseParsed.scorecard;
      }
    }

    if (phaseResults.every(p => !p.ok)) {
      return { tasks: [], scorecard: null };
    }

    const parsed = combinedParsed;
    console.log(`[edward] combined cost=$${totalCost.toFixed(2)} across ${phaseResults.length} phase(s)`);

    // Stamp scorecard.generated_at if the LLM omitted it
    if (parsed.scorecard && !parsed.scorecard.generated_at) {
      parsed.scorecard.generated_at = new Date().toISOString();
    }
    // Stamp scorecard.provider if the LLM omitted it
    if (parsed.scorecard && !parsed.scorecard.provider) {
      parsed.scorecard.provider = ciRaw.provider;
    }

    const allRaw = [...parsed.ci_findings, ...parsed.phase_1_2_3_findings];
    const tasks = allRaw.map(toEdwardTask).filter((t): t is EdwardTask => t !== null);

    // CR #1 + #3 fix: deterministic "no CI at all" guarantee.
    //
    // The "repo has zero CI → user sees a P1 suggestion" path was previously
    // 100% delegated to the LLM. Every failure mode (LLM confidence <0.7,
    // misclassified as test_gap, emitted scorecard but empty findings, parse
    // failure) dropped the finding silently. Since this is a product-level
    // must-have, we synthesize the ci_missing task in code whenever
    // CI_CONFIG_FILES is empty, then let the LLM findings refine it via
    // type+title dedupe below.
    if (ciRaw.configFiles.length === 0) {
      const already = tasks.some(t => t.type === 'ci_missing');
      if (!already) {
        const synth: EdwardTask = {
          id: uuid(),
          repo_id: '',
          signal_ids: [],
          type: 'ci_missing',
          status: 'suggested',
          title: 'Repository has no CI configuration at all',
          description:
            `No CI config files were detected by static extraction (providers scanned: ` +
            `github_actions, gitlab_ci, circleci, jenkins, travis, buildkite, azure_pipelines).\n\n` +
            `**User impact:** every change to this repo ships unverified. Regressions, ` +
            `broken builds, security vulnerabilities in dependencies, and test failures ` +
            `reach main without any automated check. This is a P1 gap for any repo with ` +
            `executable code.\n\n` +
            `**Suggested first step:** add a minimal CI pipeline (install + lint + test) ` +
            `on push and pull_request. For a ${profile.stacks.join('/') || 'this'} ` +
            `${profile.roles.join('/') || 'project'}, a single GitHub Actions workflow ` +
            `is typically enough to establish the baseline.`,
          evidence: {
            signals: [
              `REPO_PROFILE: roles=[${profile.roles.join(',')}], stacks=[${profile.stacks.join(',')}], topology=${profile.topology}`,
              `CI_CONFIG_FILES: 0 files across all known providers`,
            ],
            source: 'deterministic_static_extraction',
          },
          impact: {
            estimatedFiles: ['.github/workflows/ci.yml'],
            estimatedLinesChanged: 40,
            blastRadius: 'isolated',
          },
          verification: {
            method: 'Workflow runs on a test PR and gates merge',
            steps: [
              'Create .github/workflows/ci.yml with install + lint + test stages',
              'Open a PR; confirm the workflow triggers and all steps pass',
              'Enable branch protection to require the check on the default branch',
            ],
            successCriteria: [
              'CI workflow visible in the Actions tab',
              'PRs cannot merge unless the check passes',
            ],
          },
          confidence: 1.0,
          risk_level: 'high',
          suggested_at: new Date().toISOString(),
          approved_at: null,
          completed_at: null,
          dismiss_reason: null,
          snooze_until: null,
          execution_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        tasks.unshift(synth);
        console.log(`[edward] Synthesized deterministic ci_missing task (no CI detected)`);
      } else {
        // LLM already emitted a ci_missing finding. Force risk_level=high
        // since this is the no-CI case (CR #3: LLM default was 'low').
        for (const t of tasks) {
          if (t.type === 'ci_missing' && t.risk_level !== 'high') {
            t.risk_level = 'high';
          }
        }
      }
    }

    console.log(`[edward] Parsed ${tasks.length} tasks (${parsed.ci_findings.length} CI + ${parsed.phase_1_2_3_findings.length} product), scorecard=${parsed.scorecard ? 'yes' : 'no'}`);

    return { tasks, scorecard: parsed.scorecard };
  } catch (err: any) {
    console.error(`[edward] Agent analysis failed: ${err.message}`);
    return { tasks: [], scorecard: null };
  } finally {
    try { execSync(`rm -rf ${tmpDir}`, { stdio: 'pipe' }); } catch {}
  }
}

// ── Discuss action: spin up an ad-hoc claude CLI chat seeded with the task ──
//
// The original analysis session is non-resumable (analyzeRepoWithAgent passes
// --no-session-persistence), so "discuss" does NOT resume a session — it
// seeds a brand new claude CLI process with a fully-formed prompt built
// from the task + repo metadata. On macOS we drive Terminal.app via
// osascript so the user gets a one-click experience. On other platforms
// (or when EDWARD_FORCE_CLIPBOARD_DISCUSS=1 is set for testing) we skip
// the spawn and let the dashboard copy the launch command to the clipboard.

const CHAT_DIR_ROOT = '/tmp/edward-chats';

function buildDiscussSeed(repo: EdwardRepo, task: EdwardTask, concern?: string): string {
  const impact = task.impact as Record<string, unknown>;
  const ver = task.verification as Record<string, unknown>;

  const evidence = Object.keys(task.evidence || {}).length > 0
    ? JSON.stringify(task.evidence, null, 2)
    : '(none collected)';

  const filesArr = (impact?.estimatedFiles as string[] | undefined) || [];
  const files = filesArr.length > 0 ? filesArr.join(', ') : '(unspecified)';
  const lines = impact?.estimatedLinesChanged ?? '(unspecified)';
  const blast = impact?.blastRadius || '(unspecified)';

  const method = ver?.method || '(unspecified)';
  const stepsArr = (ver?.steps as string[] | undefined) || [];
  const steps = stepsArr.length > 0
    ? stepsArr.map((s: string, i: number) => `  ${i + 1}. ${s}`).join('\n')
    : '  (none)';
  const successArr = (ver?.successCriteria as string[] | undefined) || [];
  const success = successArr.length > 0
    ? successArr.map((s: string) => `  - ${s}`).join('\n')
    : '  (none)';

  // The concern block is the whole point of the seed — it's what the user
  // actually wants to discuss. If it was omitted (e.g. direct API call
  // with no body.concern), we tell the assistant to ask for it instead of
  // inventing one.
  const concernText = (concern && concern.trim().length > 0)
    ? concern.trim()
    : '(The user did not provide a specific concern when opening this chat. Before discussing anything else, ask them what part of this suggestion they want to interrogate.)';

  return `Hi — I'm looking at a suggestion that Edward (a local repo-maintenance
agent) surfaced while scanning one of my repositories. I'm not fully
convinced by its conclusion and I want to reason through it with you.
Please don't jump to proposing a fix — first help me interrogate the
finding itself.

## Repository
- ${repo.full_name}
- Default branch: ${repo.default_branch}
- Primary language: ${repo.language}

## Suggestion
**${task.title}**

- Type: ${task.type}
- Risk level: ${task.risk_level}
- Edward's confidence: ${task.confidence}
- Surfaced at: ${task.suggested_at ?? '(unknown)'}

### Edward's description
${task.description || '(none)'}

### Evidence Edward collected
${evidence}

### Estimated impact
- Files likely touched: ${files}
- Lines likely changed: ${lines}
- Blast radius: ${blast}

### Edward's proposed verification
- Method: ${method}
- Steps:
${steps}
- Success criteria:
${success}

---

## My specific concern

${concernText}

---

Please engage with my concern above directly. Start by restating it in
your own words so I know you got it, then give me your honest read:

- Is my concern well-founded given the evidence Edward collected?
- What additional evidence, if any, would change your mind in either direction?
- Is Edward's risk level proportional to the actual impact, or does my concern suggest it's miscalibrated?

Be direct. If you think I'm wrong, say so and tell me why.
`;
}

interface DiscussResult {
  mode: 'terminal' | 'clipboard';
  launchPath: string;
  seedPath: string;
  command: string;
  note?: string;
}

function handleDiscuss(task: EdwardTask, concern?: string): Response {
  const repo = repos.get(task.repo_id);
  if (!repo) return json({ error: 'Repo for task not found' }, 404);

  const chatDir = join(CHAT_DIR_ROOT, task.id);
  const seedPath = join(chatDir, 'seed.md');
  const launchPath = join(chatDir, 'launch.sh');

  try {
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(seedPath, buildDiscussSeed(repo, task, concern), 'utf-8');

    // launch.sh reads the seed prompt fresh from disk via $(cat seed.md), so
    // the prompt never touches shell or AppleScript escaping. CLAUDE_BIN is
    // a trusted path resolved at server start (env var or Bun.which) — no
    // user input flows into it.
    const launchScript = `#!/bin/bash
cd "$(dirname "$0")"
exec "${CLAUDE_BIN}" "$(cat seed.md)"
`;
    writeFileSync(launchPath, launchScript, 'utf-8');
    chmodSync(launchPath, 0o755);
  } catch (err: any) {
    return json({ error: `Failed to write chat files: ${err.message}` }, 500);
  }

  const command = `bash ${launchPath}`;
  const forceClipboard = process.env.EDWARD_FORCE_CLIPBOARD_DISCUSS === '1';
  const isDarwin = process.platform === 'darwin';
  const result: DiscussResult = { mode: 'clipboard', launchPath, seedPath, command };

  if (isDarwin && !forceClipboard) {
    try {
      // launchPath is under /tmp/edward-chats/<uuid>/ — uuid is hex only,
      // so the path cannot contain AppleScript or shell metacharacters.
      const doScript = `tell application "Terminal" to do script "bash ${launchPath}"`;
      const activate = 'tell application "Terminal" to activate';
      const proc = spawn('osascript', ['-e', doScript, '-e', activate], {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      result.mode = 'terminal';
    } catch (err: any) {
      result.note = `osascript failed (${err.message}); returning clipboard fallback`;
    }
  }

  return json(result);
}

interface ParsedAnalysis {
  ci_findings: any[];
  phase_1_2_3_findings: any[];
  scorecard: CIScorecard | null;
}

/**
 * Tolerant parser for the LLM analysis output.
 *
 * Strategy: try in order, take the first that produces a usable shape:
 *   1. Direct JSON.parse of the trimmed text
 *   2. First balanced `{...}` found anywhere in the text (handles
 *      markdown-wrapped responses + trailing prose + nested code fences
 *      inside string values)
 *   3. First balanced `[...]` (legacy v0.3 flat-array shape)
 *
 * If everything fails, dump the raw text to /tmp/edward-parse-failure-<ts>.txt
 * and log the path so the failure is debuggable without re-running the
 * (expensive) discover. Returns the empty shape on total failure.
 *
 * Never throws.
 */
/**
 * Strip trailing prose from a JSON response. Walks from the last `}`
 * backwards looking for a depth-zero match to an earlier `{` such that
 * the slice in between is itself valid JSON. Used as an Attempt 2.5
 * between the "direct parse" and "greedy [...]" strategies.
 *
 * Returns null if no parseable {...} prefix is found.
 */
function stripTrailingProseAndParse(text: string): any | null {
  // Try progressively earlier `}` positions. Cheap and bounded: most
  // malformed responses only need one or two retries.
  let searchEnd = text.length;
  for (let attempt = 0; attempt < 5; attempt++) {
    const lastClose = text.lastIndexOf('}', searchEnd - 1);
    if (lastClose < 0) return null;
    const firstOpen = text.indexOf('{');
    if (firstOpen < 0 || firstOpen >= lastClose) return null;
    const slice = text.slice(firstOpen, lastClose + 1);
    try {
      return JSON.parse(slice);
    } catch {
      searchEnd = lastClose;
    }
  }
  return null;
}

function parseAnalysisResult(text: string): ParsedAnalysis {
  const empty: ParsedAnalysis = { ci_findings: [], phase_1_2_3_findings: [], scorecard: null };

  // Always dump the raw text so post-mortem doesn't require re-running
  // the (expensive) discover. Cheap: it's a few hundred KB at most, and
  // each run gets its own file. Useful regardless of parse success.
  try {
    const dumpPath = `/tmp/edward-raw-analysis-${Date.now()}.txt`;
    writeFileSync(dumpPath, text, 'utf-8');
    console.log(`[edward] Raw LLM output dumped to ${dumpPath} (${text.length} bytes)`);
  } catch { /* best effort */ }

  const tryShape = (parsed: any): ParsedAnalysis | null => {
    if (!parsed) return null;
    // New shape: object with at least one of the three expected keys
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ci = Array.isArray(parsed.ci_findings) ? parsed.ci_findings : [];
      const p123 = Array.isArray(parsed.phase_1_2_3_findings) ? parsed.phase_1_2_3_findings : [];
      const scorecard: CIScorecard | null = parsed.ci_scorecard && typeof parsed.ci_scorecard === 'object'
        ? parsed.ci_scorecard
        : null;
      // Accept the object if it has ANY of the three expected keys — even if
      // all three are empty/null. A correct-shape-but-empty result (LLM
      // legitimately found nothing) must not be misclassified as a parse
      // failure; that was the CR #2 bug, which combined with CR #1 burned
      // $1+ runs and showed users "0 findings" + a /tmp dump.
      const hasKnownKey =
        'ci_findings' in parsed ||
        'phase_1_2_3_findings' in parsed ||
        'ci_scorecard' in parsed;
      if (hasKnownKey) {
        return { ci_findings: ci, phase_1_2_3_findings: p123, scorecard };
      }
      // Object lacks every known key — wrong shape, give up on this attempt
      // (don't fall through to "treat as phase_1_2_3" here, a wrong-shape
      // object would be silently dropped).
      return null;
    }
    // Legacy flat array of tasks — STRICT: every element must look like
    // a task object (has .title and is an object). This prevents a very
    // nasty failure mode we hit on ama-user-service:
    //   Attempt 1 failed (malformed outer JSON)
    //   Attempt 2 failed (same slice, still malformed)
    //   Attempt 3 grabbed the FIRST `[...]` slice, which turned out to
    //     be `ci_scorecard.dimensions.presence.evidence`: an array of
    //     strings describing CI files. JSON.parse succeeded because
    //     a string array is valid JSON; tryShape saw Array.isArray →
    //     returned them as phase_1_2_3_findings. Downstream
    //     toEdwardTask rejected all of them (no .title) → 0 tasks
    //     saved, scorecard=no, and the user lost a 14-minute $1.45 run.
    if (Array.isArray(parsed)) {
      const looksLikeTasks = parsed.length > 0 && parsed.every(
        t => t && typeof t === 'object' && typeof t.title === 'string'
      );
      if (!looksLikeTasks) return null;
      return { ci_findings: [], phase_1_2_3_findings: parsed, scorecard: null };
    }
    return null;
  };

  // Attempt 1: direct parse
  try {
    const parsed = JSON.parse(text.trim());
    const shaped = tryShape(parsed);
    if (shaped) return shaped;
  } catch { /* try next */ }

  // Attempt 2: first balanced {...} object anywhere in the text
  const objSlice = findFirstBalancedJson(text, '{');
  if (objSlice) {
    try {
      const parsed = JSON.parse(objSlice);
      const shaped = tryShape(parsed);
      if (shaped) return shaped;
    } catch { /* try next */ }
  }

  // Attempt 2.5: strip trailing prose. If the LLM added a postscript
  // after the JSON body (e.g. "Note: this analysis took 80 turns."),
  // both Attempt 1 (trailing text) and Attempt 2 (still parses because
  // findFirstBalancedJson returns the full outer slice which is valid)
  // should have already succeeded. This attempt is for the OTHER
  // failure mode: the outer {...} IS malformed JSON (missing comma,
  // unescaped quote, trailing comma) but a strict PREFIX of it is
  // valid. Walk back from the last `}` to find the longest parseable
  // prefix.
  const prefixParsed = stripTrailingProseAndParse(text);
  if (prefixParsed) {
    const shaped = tryShape(prefixParsed);
    if (shaped) return shaped;
  }

  // Attempt 3: first balanced [...] array (legacy v0.3 shape)
  const arrSlice = findFirstBalancedJson(text, '[');
  if (arrSlice) {
    try {
      const parsed = JSON.parse(arrSlice);
      const shaped = tryShape(parsed);
      if (shaped) return shaped;
    } catch { /* fall through */ }
  }

  // Total failure: dump raw text for offline debugging.
  // Edward is expensive to re-run ($1+, ~7 min) so silent failures are
  // very costly. Dumping the raw text means the user can `cat` the
  // file, see what Claude actually returned, and (in the worst case)
  // hand-extract findings or rerun with a different prompt — without
  // burning another scan.
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpPath = `/tmp/edward-parse-failure-${ts}.txt`;
    writeFileSync(dumpPath, text, 'utf-8');
    console.error(`[edward] Could not parse Claude output as the expected shape.`);
    console.error(`[edward] Raw output dumped to: ${dumpPath}`);
    console.error(`[edward]   inspect with: cat ${dumpPath}`);
  } catch (dumpErr: any) {
    console.error(`[edward] Could not parse Claude output, AND dump failed: ${dumpErr?.message || dumpErr}`);
  }
  return empty;
}

// ── Route handlers ──

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return cors();

  // Dashboard
  if (path === '/' && method === 'GET') {
    try {
      const html = readFileSync(DASHBOARD_HTML_PATH, 'utf-8');
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    } catch {
      return new Response('<h1>Edward Dashboard</h1><p>dashboard.html not found</p>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  // Health
  if (path === '/health') {
    return json({ status: 'healthy', timestamp: new Date().toISOString(), checks: { database: 'ok', redis: 'ok' } });
  }
  if (path === '/ready') return json({ ready: true });

  // Repos
  if (path === '/api/v1/repos' && method === 'GET') {
    return json({ repos: [...repos.values()].filter(r => r.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name)) });
  }

  if (path === '/api/v1/repos' && method === 'POST') {
    const body = await req.json() as { full_name: string };
    const result = await addRepoByFullName(body.full_name);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ repo: result.repo, created: result.created }, result.created ? 201 : 200);
  }

  // Repo by ID
  const repoMatch = path.match(/^\/api\/v1\/repos\/([^/]+)$/);
  if (repoMatch && method === 'GET') {
    const repo = repos.get(repoMatch[1]);
    return repo ? json({ repo }) : json({ error: 'Not found' }, 404);
  }

  // CI scorecard (read from repo.settings, populated by analyzeRepoWithAgent)
  const scorecardMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/ci-scorecard$/);
  if (scorecardMatch && method === 'GET') {
    const repo = repos.get(scorecardMatch[1]);
    if (!repo) return json({ error: 'Repo not found' }, 404);
    return json({
      scorecard: repo.settings.ci_scorecard ?? null,
      generated_at: repo.settings.ci_scorecard_at ?? null,
      last_discover_at: repo.settings.last_discover_at ?? null,
    });
  }

  // Suggestions
  const suggestMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/suggestions$/);
  if (suggestMatch && method === 'GET') {
    const repoTasks = [...tasks.values()]
      .filter(t => t.repo_id === suggestMatch[1] && t.status === 'suggested')
      .sort((a, b) => b.confidence - a.confidence)
      // Slice raised from 10 to 30 to match the expanded SAVE_CAP and
      // expose long-tail findings in the primary "Suggestions" view.
      .slice(0, 30);
    return json({
      suggestions: repoTasks.map(task => ({
        task,
        actions: {
          approveUrl: `/api/v1/tasks/${task.id}/action`,
          dismissUrl: `/api/v1/tasks/${task.id}/action`,
          snoozeUrl: `/api/v1/tasks/${task.id}/action`,
        },
      })),
    });
  }

  // Discovery status
  const discoverStatusMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/discover\/status$/);
  if (discoverStatusMatch && method === 'GET') {
    const repoTasks = [...tasks.values()].filter(t => t.repo_id === discoverStatusMatch[1]);
    return json({ running: discoveryRunning, taskCount: repoTasks.length });
  }

  // Discover (async — returns immediately, runs analysis in background)
  // Query param: ?skip_product=1 → only run Phase 0 (CI audit), faster.
  const discoverMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/discover$/);
  if (discoverMatch && method === 'POST') {
    const repo = repos.get(discoverMatch[1]);
    if (!repo) return json({ error: 'Repo not found' }, 404);

    // Optional ?provider=claude|codex query param. Reject invalid values
    // so silent fallback to default doesn't mask a misconfigured client.
    const providerParam = url.searchParams.get('provider');
    let provider: Provider | undefined;
    if (providerParam !== null) {
      if (!isProvider(providerParam)) {
        return json({ error: `Invalid provider '${providerParam}'. Valid: claude, codex` }, 400);
      }
      provider = providerParam;
    }

    if (discoveryRunning) return json({ tasks: [], count: 0, message: 'Discovery already running' });
    discoveryRunning = true;

    const skipProduct = url.searchParams.get('skip_product') === '1';
    const noFallback = url.searchParams.get('no_fallback') === '1';

    // Optional ?branch=<name> to scan a non-default branch. Validated
    // against a conservative ref-name regex so we don't shell-inject
    // into `git clone --branch`. Matches common branch/tag naming
    // without being overly strict — allows foo/bar, feature-123,
    // v1.2.3, release.2026-04-08.
    const branchParam = url.searchParams.get('branch');
    let branch: string | undefined;
    if (branchParam !== null && branchParam !== '') {
      if (!/^[A-Za-z0-9._/\-]{1,200}$/.test(branchParam) ||
          branchParam.startsWith('-') ||
          branchParam.includes('..')) {
        return json({ error: `Invalid branch '${branchParam}'. Only [A-Za-z0-9._/-] allowed, no leading '-', no '..'` }, 400);
      }
      branch = branchParam;
    }

    // Run in background — return immediately
    (async () => {
      try {
        const logOpts = [
          skipProduct ? 'skip_product' : null,
          provider ? `provider=${provider}` : null,
          branch ? `branch=${branch}` : null,
        ].filter(Boolean).join(', ');
        console.log(`[edward] Running agent analysis for ${repo.full_name}${logOpts ? ` (${logOpts})` : ''}...`);
        const result = await analyzeRepoWithAgent(repo.full_name, { skipProduct, provider, allowFallback: !noFallback, branch });

        // Stamp "discovery ran" regardless of outcome so the dashboard can
        // distinguish "never ran" vs "ran but no scorecard returned" (CR #4).
        repo.settings.last_discover_at = new Date().toISOString();
        repo.updated_at = new Date().toISOString();

        // Persist the scorecard onto the repo's settings field (existing
        // extensible Record<string, unknown>, no schema migration needed).
        if (result.scorecard) {
          repo.settings.ci_scorecard = result.scorecard;
          repo.settings.ci_scorecard_at = new Date().toISOString();
        }

        // Save tasks (with dedupe). Cap raised from 15 to 50 to
        // accommodate exhaustive scans (no per-category quota anymore;
        // a real codebase like clawschool with multiple security +
        // payment + auth issues can produce 25+ findings legitimately).
        let saved = 0;
        const SAVE_CAP = 50;
        for (const at of result.tasks) {
          const dup = [...tasks.values()].find(
            t => t.repo_id === repo.id && t.type === at.type && t.title === at.title && !['dismissed', 'merged', 'failed'].includes(t.status)
          );
          if (dup) continue;

          at.repo_id = repo.id;
          tasks.set(at.id, at);
          saved++;
          if (saved >= SAVE_CAP) break;
        }

        console.log(`[edward] Discovery complete: ${saved} tasks saved, scorecard=${result.scorecard ? `${result.scorecard.overall_score}/100` : 'none'} for ${repo.full_name}`);
      } catch (err: any) {
        console.error(`[edward] Discovery failed: ${err.message}`);
      } finally {
        discoveryRunning = false;
      }
    })();

    return json({ tasks: [], count: 0, message: 'Discovery started in background. Poll /discover/status or refresh the dashboard.' });
  }

  // Tasks
  const tasksMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/tasks$/);
  if (tasksMatch && method === 'GET') {
    const repoTasks = [...tasks.values()]
      .filter(t => t.repo_id === tasksMatch[1])
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return json({ tasks: repoTasks, count: repoTasks.length });
  }

  // Task action
  const actionMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/action$/);
  if (actionMatch && method === 'POST') {
    const task = tasks.get(actionMatch[1]);
    if (!task) return json({ error: 'Task not found' }, 404);
    const body = await req.json() as { action: string; reason?: string; snoozeUntil?: string; concern?: string };

    switch (body.action) {
      case 'approve': {
        task.status = 'approved';
        task.approved_at = new Date().toISOString();
        const exec: EdwardExecution = {
          id: uuid(), task_id: task.id, repo_id: task.repo_id, status: 'queued',
          agent_provider: 'edward_runtime', branch_name: `edward/${task.type}-${Date.now().toString(36)}`,
          pr_url: null, logs: [{ timestamp: new Date().toISOString(), level: 'info', message: 'Task approved, execution queued' }],
          started_at: null, completed_at: null, created_at: new Date().toISOString(),
        };
        executions.set(exec.id, exec);
        task.execution_id = exec.id;
        return json({ status: 'approved', execution: exec });
      }
      case 'dismiss':
        task.status = 'dismissed';
        task.dismiss_reason = body.reason || 'Dismissed from dashboard';
        return json({ status: 'dismissed' });
      case 'snooze':
        task.status = 'snoozed';
        task.snooze_until = body.snoozeUntil || new Date(Date.now() + 86400000).toISOString();
        return json({ status: 'snoozed', until: task.snooze_until });
      case 'discuss':
        // Read-only action: spins up a claude CLI chat seeded with the task
        // context + the user's specific concern. Does NOT mutate task state.
        return handleDiscuss(task, body.concern);
      default:
        return json({ error: 'Invalid action' }, 400);
    }
  }

  // Stats
  const statsMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/stats$/);
  if (statsMatch && method === 'GET') {
    const repoTasks = [...tasks.values()].filter(t => t.repo_id === statsMatch[1]);
    const byStatus: Record<string, number> = {};
    repoTasks.forEach(t => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
    const total = repoTasks.length;
    const accepted = (byStatus.approved || 0) + (byStatus.executing || 0) + (byStatus.pr_created || 0) + (byStatus.merged || 0);
    return json({
      period: '30d', tasks: byStatus, executions: {},
      metrics: {
        acceptanceRate: total > 0 ? Math.round(accepted / total * 100) : 0,
        mergeRate: 0, totalSuggested: total, totalAccepted: accepted, totalMerged: byStatus.merged || 0,
      },
    });
  }

  // Executions
  if (path === '/api/v1/executions' && method === 'GET') {
    return json({ executions: [...executions.values()].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) });
  }

  // Webhooks (no-op for edward)
  if (path === '/api/v1/webhooks/github') return json({ ok: true });

  return json({ error: 'Not found' }, 404);
}

// ── Start server ──

export function startEdwardServer(port = 8080): void {
  const server = Bun.serve({
    port,
    idleTimeout: 255, // max allowed by Bun
    fetch: handleRequest,
  });
  console.log(`\n  ◆ Edward Dashboard: http://localhost:${server.port}/`);
  console.log(`    API: http://localhost:${server.port}/api/v1/repos\n`);
  // Fire-and-forget seed load — never blocks startup, never crashes the server.
  loadSeedFile().catch((err) => console.error(`[edward] seed: load crashed: ${err?.message || err}`));
}

export { repos, tasks, executions };
