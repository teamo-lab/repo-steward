/**
 * Edward Dashboard Server — lightweight HTTP server for Repo Steward UI.
 * Runs alongside the Claude Code CLI to serve the dashboard and API.
 *
 * Uses Bun's native HTTP server (no Fastify needed in the edward build).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, '..', '..', '..', '..', 'src', 'dashboard.html');

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

// ── Agent analysis using claude CLI ──

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/zhangyiming/.local/bin/claude';

const ANALYSIS_PROMPT = `You are Repo Steward, an expert engineering analyst. Analyze this codebase and find concrete, actionable maintenance tasks that a coding agent can safely execute as a pull request.

RULES:
- Only suggest tasks you are HIGHLY confident about based on actual code
- Each task must be specific enough for another AI agent to implement
- Prefer small, isolated, low-risk changes
- Focus on code health, not style preferences

DIMENSIONS: dead code, TODO/FIXME, error handling gaps, type safety, test gaps, dependency issues, security, performance, config drift, documentation gaps

Return ONLY a JSON array (no markdown):
[{"type":"code_quality|security_fix|perf_improvement|dead_code|test_gap|todo_cleanup|dependency_upgrade|error_handling|type_safety|config_drift|doc_gap","title":"Short title","description":"2-3 sentences","confidence":0.0-1.0,"riskLevel":"low|medium|high","evidence":{"signals":["evidence"],"codeSnippets":[{"file":"path","line":42,"content":"code"}]},"impact":{"estimatedFiles":["path"],"estimatedLinesChanged":25,"blastRadius":"isolated|module"},"verification":{"method":"how to verify","steps":["step"],"successCriteria":["criterion"]}}]

Find 5-15 tasks with confidence >= 0.6.`;

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
        '--max-turns', '10',
        '--max-budget-usd', '2',
      ], {
        cwd: `${tmpDir}/repo`,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { proc.kill('SIGTERM'); }, 600_000);
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

    return parsed.filter((t: any) => t && t.title && t.confidence >= 0.6).map((t: any) => ({
      id: uuid(),
      repo_id: '',
      signal_ids: [],
      type: t.type || 'code_quality',
      status: 'suggested',
      title: String(t.title),
      description: String(t.description || ''),
      evidence: t.evidence || { signals: [] },
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
    if (!body.full_name || !body.full_name.includes('/')) {
      return json({ error: 'full_name required (owner/repo)' }, 400);
    }
    const existing = [...repos.values()].find(r => r.full_name === body.full_name);
    if (existing) return json({ repo: existing, created: false });

    const [owner, name] = body.full_name.split('/');
    let githubId = Math.floor(Math.random() * 900000000);
    let language = 'Unknown';
    let defaultBranch = 'main';

    try {
      const res = await fetch(`https://api.github.com/repos/${body.full_name}`, {
        headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'edward' },
      });
      if (res.ok) {
        const d = await res.json() as any;
        githubId = d.id; language = d.language || 'Unknown'; defaultBranch = d.default_branch || 'main';
      }
    } catch {}

    const repo: EdwardRepo = {
      id: uuid(), github_id: githubId, owner, name, full_name: body.full_name,
      installation_id: '0', default_branch: defaultBranch, language, is_active: true,
      settings: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    repos.set(repo.id, repo);
    return json({ repo, created: true }, 201);
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
    const body = await req.json() as { action: string; reason?: string; snoozeUntil?: string };

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
}

export { repos, tasks, executions };
