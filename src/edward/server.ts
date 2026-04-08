/**
 * Edward Dashboard Server — lightweight HTTP server for Repo Steward UI.
 * Shells out to the `claude` CLI binary (CLAUDE_BIN) to run agent analyses.
 *
 * Uses Bun's native HTTP server (no Fastify needed in the edward build).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

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

const CLAUDE_BIN = process.env.CLAUDE_BIN || Bun.which('claude') || 'claude';

const ANALYSIS_PROMPT = `You are Repo Steward, a senior product engineer doing a pre-incident review of a real production codebase. Your job is to find PRODUCT-LEVEL risks that a smart human reviewer would care about — not just generic code-health nits.

══════════════════════════════════════
PHASE 1 — UNDERSTAND THE PRODUCT (mandatory, do this first)
══════════════════════════════════════
Before suggesting anything, you MUST:
1. Read README.md / README.* / docs/ to learn what this product actually does
2. Identify the top 3-5 user-facing features (sign-up, login, payment, upload, deployment, search, etc.)
3. Find the entry points for those features (HTTP routes, CLI commands, API endpoints, UI handlers)
4. Trace at least one critical flow end-to-end from user input → response

If there is no README, use directory structure + main entry files to infer the product.

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
- BE HONEST: if the codebase is healthy and you can only find nits, return fewer items
- TARGET: 8-15 findings, with at least 5 being PHASE 2 (functional) findings if any exist
- Each task must be specific enough for another coding agent to fix as a small PR

══════════════════════════════════════
OUTPUT FORMAT (JSON array only, no markdown)
══════════════════════════════════════
[{
  "type": "functional_bug|flow_break|ux_gap|compat_risk|doc_drift|security_fix|perf_improvement|dead_code|error_handling|test_gap|code_quality",
  "title": "Short, action-oriented title (e.g. 'Skill installer fails on Windows due to hardcoded /tmp path')",
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
}]

Find 8-15 tasks with confidence >= 0.65. Prioritize Phase 2 functional findings.`;

async function analyzeRepoWithAgent(fullName: string): Promise<EdwardTask[]> {
  const tmpDir = `/tmp/edward-${Date.now()}`;

  try {
    // Clone
    execSync(`git clone --depth 1 https://github.com/${fullName}.git ${tmpDir}/repo`, {
      timeout: 60_000,
      stdio: 'pipe',
    });

    // Run Claude analysis
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn(CLAUDE_BIN, [
        '-p', ANALYSIS_PROMPT,
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--no-session-persistence',
        '--model', 'sonnet',
        '--max-turns', '40',
        '--max-budget-usd', '5',
      ], {
        cwd: `${tmpDir}/repo`,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { proc.kill('SIGTERM'); }, 1_200_000); // 20 min for deep analysis
      proc.on('close', () => { clearTimeout(timer); resolve(out); });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    const result = JSON.parse(stdout);
    console.log(`[edward] Claude response: cost=$${result.total_cost_usd?.toFixed(2)}, duration=${result.duration_ms}ms, error=${result.is_error}`);
    if (result.is_error || !result.result) {
      console.error(`[edward] Claude error: ${result.result?.slice?.(0, 200)}`);
      return [];
    }

    console.log(`[edward] Raw result preview: ${result.result.slice(0, 300)}...`);

    // Parse tasks from Claude output
    let parsed: unknown[];
    try {
      parsed = JSON.parse(result.result);
    } catch {
      // Try extracting from markdown code block
      const codeMatch = result.result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeMatch) {
        try { parsed = JSON.parse(codeMatch[1]); } catch { parsed = []; }
      } else {
        const match = result.result.match(/\[[\s\S]*\]/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch { parsed = []; }
        } else {
          console.error(`[edward] Could not parse Claude output as JSON`);
          return [];
        }
      }
    }

    console.log(`[edward] Parsed ${Array.isArray(parsed) ? parsed.length : 0} raw tasks`);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((t: any) => t && t.title && t.confidence >= 0.65).map((t: any) => ({
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
    }));
  } catch (err: any) {
    console.error(`[edward] Agent analysis failed: ${err.message}`);
    return [];
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

  // Suggestions
  const suggestMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/suggestions$/);
  if (suggestMatch && method === 'GET') {
    const repoTasks = [...tasks.values()]
      .filter(t => t.repo_id === suggestMatch[1] && t.status === 'suggested')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
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
  const discoverMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/discover$/);
  if (discoverMatch && method === 'POST') {
    const repo = repos.get(discoverMatch[1]);
    if (!repo) return json({ error: 'Repo not found' }, 404);

    if (discoveryRunning) return json({ tasks: [], count: 0, message: 'Discovery already running' });
    discoveryRunning = true;

    // Run in background — return immediately
    (async () => {
      try {
        console.log(`[edward] Running agent analysis for ${repo.full_name}...`);
        const agentTasks = await analyzeRepoWithAgent(repo.full_name);

        let saved = 0;
        for (const at of agentTasks) {
          const dup = [...tasks.values()].find(
            t => t.repo_id === repo.id && t.type === at.type && t.title === at.title && !['dismissed', 'merged', 'failed'].includes(t.status)
          );
          if (dup) continue;

          at.repo_id = repo.id;
          tasks.set(at.id, at);
          saved++;
          if (saved >= 10) break;
        }

        console.log(`[edward] Discovery complete: ${saved} tasks saved for ${repo.full_name}`);
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
          agent_provider: 'claude_code', branch_name: `edward/${task.type}-${Date.now().toString(36)}`,
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
