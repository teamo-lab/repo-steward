/**
 * Edward CLI — gh/kubectl-style subcommands for the proactive agent.
 *
 * All state lives in the dashboard server (in-memory Map). The CLI is a thin
 * HTTP client that talks to it, so it stays consistent with the web UI.
 *
 * Usage:
 *   edward serve                          Start the dashboard server
 *   edward repos                          List tracked repos
 *   edward repos add owner/repo           Add a repo (fetches GitHub metadata)
 *   edward repos rm <repo>                Remove a repo
 *   edward discover <repo> [--wait]       Trigger agent analysis
 *   edward suggestions <repo>             Top 10 open suggestions
 *   edward tasks <repo>                   All tasks for a repo
 *   edward approve <task>                 Approve a task → queue execution
 *   edward dismiss <task> [--reason "..."] Dismiss a task
 *   edward snooze <task> [--until ISO]    Snooze a task (default 24h)
 *   edward stats <repo>                   Repo stats
 *   edward executions                     List executions
 *   edward version                        Print version
 *
 * Flags:
 *   --json     Emit raw JSON (pipeable)
 *   --url URL  Override EDWARD_URL (default http://localhost:8080)
 *
 * `<repo>` accepts either `owner/repo` or a UUID prefix.
 * `<task>` accepts a UUID prefix (first 8 chars is enough when unambiguous).
 */

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolveClaudeBin, describeAuthEnv } from './server.js';
import { describeProviderAuth, type ProviderAuthStatus } from './llm_provider.js';

const DEFAULT_URL = process.env.EDWARD_URL || 'http://localhost:8080';

// ── ANSI helpers ──
const tty = process.stdout.isTTY;
const c = {
  reset: tty ? '\x1b[0m' : '',
  bold: tty ? '\x1b[1m' : '',
  dim: tty ? '\x1b[2m' : '',
  red: tty ? '\x1b[31m' : '',
  green: tty ? '\x1b[32m' : '',
  yellow: tty ? '\x1b[33m' : '',
  blue: tty ? '\x1b[34m' : '',
  magenta: tty ? '\x1b[35m' : '',
  cyan: tty ? '\x1b[36m' : '',
  gray: tty ? '\x1b[90m' : '',
};

function colorForType(type: string): string {
  if (['functional_bug', 'flow_break'].includes(type)) return c.red;
  if (['ux_gap', 'compat_risk'].includes(type)) return c.yellow;
  if (['security_fix'].includes(type)) return c.red;
  if (['doc_drift', 'doc_gap', 'config_drift'].includes(type)) return c.gray;
  if (['perf_improvement', 'dependency_upgrade'].includes(type)) return c.yellow;
  if (['error_handling', 'type_safety'].includes(type)) return c.blue;
  if (['test_gap'].includes(type)) return c.green;
  if (['dead_code', 'code_quality'].includes(type)) return c.magenta;
  // CI audit types (Sprint 1)
  if (['ci_missing', 'ci_fake', 'ci_insecure'].includes(type)) return c.red;
  if (['ci_weak', 'ci_governance_gap'].includes(type)) return c.yellow;
  return c.cyan;
}

function colorForRisk(risk: string): string {
  if (risk === 'high') return c.red;
  if (risk === 'medium') return c.yellow;
  return c.green;
}

function colorForStatus(status: string): string {
  if (['suggested'].includes(status)) return c.blue;
  if (['approved', 'executing', 'queued'].includes(status)) return c.yellow;
  if (['pr_created', 'verified', 'merged'].includes(status)) return c.green;
  if (['dismissed', 'failed'].includes(status)) return c.red;
  if (['snoozed'].includes(status)) return c.gray;
  return c.cyan;
}

// ── Arg parsing ──

type Provider = 'claude' | 'codex';
const VALID_PROVIDERS: Provider[] = ['claude', 'codex'];

interface ParsedArgs {
  _: string[];           // positional
  json: boolean;
  url: string;
  wait: boolean;
  reason?: string;
  until?: string;
  port?: number;
  help: boolean;
  yes: boolean;
  provider?: Provider;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], json: false, url: DEFAULT_URL, wait: false, help: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--wait') out.wait = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--url') { out.url = argv[++i] || DEFAULT_URL; }
    else if (a === '--reason') { out.reason = argv[++i]; }
    else if (a === '--until') { out.until = argv[++i]; }
    else if (a === '--port' || a === '-p') { out.port = parseInt(argv[++i] || '0', 10); }
    else if (a === '--provider') { out.provider = parseProvider(argv[++i]); }
    else if (a.startsWith('--url=')) { out.url = a.slice(6); }
    else if (a.startsWith('--reason=')) { out.reason = a.slice(9); }
    else if (a.startsWith('--until=')) { out.until = a.slice(8); }
    else if (a.startsWith('--port=')) { out.port = parseInt(a.slice(7), 10); }
    else if (a.startsWith('--provider=')) { out.provider = parseProvider(a.slice(11)); }
    else out._.push(a);
  }
  return out;
}

function parseProvider(value: string | undefined): Provider {
  if (!value) {
    throw new Error(`--provider requires a value. Valid: ${VALID_PROVIDERS.join(', ')}`);
  }
  if (!(VALID_PROVIDERS as string[]).includes(value)) {
    throw new Error(`Invalid --provider '${value}'. Valid: ${VALID_PROVIDERS.join(', ')}`);
  }
  return value as Provider;
}

/**
 * Determine the effective provider for this invocation.
 * Precedence: --provider flag → EDWARD_PROVIDER env → default 'claude'.
 * Also reports the source so doctor can show where the choice came from.
 */
function resolveEffectiveProvider(args: ParsedArgs): { provider: Provider; source: 'flag' | 'env' | 'default' } {
  if (args.provider) return { provider: args.provider, source: 'flag' };
  const envVal = process.env.EDWARD_PROVIDER;
  if (envVal && (VALID_PROVIDERS as string[]).includes(envVal)) {
    return { provider: envVal as Provider, source: 'env' };
  }
  return { provider: 'claude', source: 'default' };
}

// ── HTTP client ──
async function api<T = any>(url: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  }).catch((e: Error) => {
    throw new Error(`Cannot reach Edward server at ${url}: ${e.message}\nStart it with: edward serve`);
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Prefer the server's `error` field if it returned JSON
    let msg = body || res.statusText;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') msg = parsed.error;
    } catch {}
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

// ── Repo / task ID resolution ──
async function resolveRepo(url: string, query: string): Promise<{ id: string; full_name: string }> {
  const { repos } = await api<{ repos: Array<{ id: string; full_name: string }> }>(url, '/api/v1/repos');
  // Exact full_name match
  const byName = repos.find(r => r.full_name === query);
  if (byName) return byName;
  // UUID prefix match
  const byId = repos.filter(r => r.id.startsWith(query));
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) throw new Error(`Ambiguous repo id '${query}' matches ${byId.length} repos`);
  throw new Error(`No repo found matching '${query}'. Try: edward repos`);
}

async function resolveTask(
  url: string,
  query: string
): Promise<{ id: string; title: string; repo_id: string }> {
  const { repos } = await api<{ repos: Array<{ id: string }> }>(url, '/api/v1/repos');
  for (const r of repos) {
    const { tasks } = await api<{ tasks: Array<{ id: string; title: string; repo_id: string }> }>(
      url,
      `/api/v1/repos/${r.id}/tasks`
    );
    const hit = tasks.find(t => t.id === query || t.id.startsWith(query));
    if (hit) return hit;
  }
  throw new Error(`No task found matching '${query}'`);
}

// ── Output helpers ──
function out(args: ParsedArgs, data: unknown, pretty: () => void): void {
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    pretty();
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function padEnd(s: string, n: number): string {
  // strip ansi for length calc
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (stripped.length >= n) return s;
  return s + ' '.repeat(n - stripped.length);
}

// ── Preflight helpers (first-run auth check) ──

async function promptYesNo(question: string, defaultNo = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultNo ? ' [y/N] ' : ' [Y/n] ';
    const ans = (await rl.question(question + hint)).trim().toLowerCase();
    if (ans === '') return !defaultNo;
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Render a single provider's section in `edward doctor` output.
 * Returns true if the provider is fully usable (binary + auth both OK).
 */
function renderProviderSection(status: ProviderAuthStatus, active: boolean): boolean {
  const label = status.provider === 'claude' ? 'Claude' : 'Codex';
  const marker = active ? `${c.bold}[active]${c.reset}` : `${c.dim}[inactive]${c.reset}`;
  console.log(`${c.bold}${label}${c.reset}  ${marker}`);

  if (!status.binaryPath) {
    console.log(`  ${c.red}✗${c.reset} binary not found`);
    if (status.binaryResolveError) {
      for (const line of status.binaryResolveError.split('\n')) {
        console.log(`    ${c.dim}${line}${c.reset}`);
      }
    }
    return false;
  }

  console.log(`  ${c.green}✓${c.reset} binary:  ${status.binaryPath}`);
  if (status.version) {
    console.log(`    ${c.dim}version: ${status.version}${c.reset}`);
  }

  if (status.apiKeySet) {
    console.log(
      `  ${c.yellow}⚠${c.reset} auth:    ${c.bold}${status.apiKeyEnvVar}${c.reset} ` +
      `${c.dim}(${status.apiKeyPreview})${c.reset} ${c.yellow}— overrides OAuth${c.reset}`
    );
  } else if (status.oauthAvailable === 'likely') {
    console.log(`  ${c.green}✓${c.reset} auth:    OAuth credentials detected`);
  } else {
    console.log(`  ${c.red}✗${c.reset} auth:    no OAuth credentials found, no ${status.apiKeyEnvVar}`);
  }
  for (const line of status.suggestion.split('\n')) {
    console.log(`    ${c.dim}${line}${c.reset}`);
  }

  // Usable = binary resolved AND (OAuth OR API key set)
  return status.binaryPath !== null && (status.oauthAvailable === 'likely' || status.apiKeySet);
}

/**
 * Runs before `edward serve` actually binds to a port.
 *
 * Catches the two most common first-run mistakes on a fresh clone:
 *   1. the chosen provider's CLI isn't installed / not on PATH
 *   2. a stray API key in the shell rc silently takes over
 *      from the user's OAuth login without them realizing.
 *
 * Returns `true` on success (or user-confirmed proceed), `false` on
 * abort. Prints all output inline — caller decides the exit code.
 */
async function preflightAuth(args: ParsedArgs): Promise<boolean> {
  const { provider } = resolveEffectiveProvider(args);
  const status = describeProviderAuth(provider);

  if (!status.binaryPath) {
    console.error(`${c.red}error:${c.reset} ${status.binaryResolveError || `${provider} binary not found`}`);
    return false;
  }
  console.log(`${c.dim}${provider} binary:${c.reset} ${status.binaryPath}`);

  if (status.apiKeySet) {
    console.log(
      `${c.yellow}⚠${c.reset}  ${status.apiKeyEnvVar} detected ${c.dim}(${status.apiKeyPreview})${c.reset}`
    );
    for (const line of status.suggestion.split('\n')) {
      console.log(`   ${c.dim}${line}${c.reset}`);
    }

    if (args.yes || !process.stdin.isTTY) {
      console.log(`   ${c.dim}(proceeding — --yes or non-TTY)${c.reset}`);
      return true;
    }
    const go = await promptYesNo('\nContinue with API key billing?', true);
    if (!go) {
      console.log(`\n${c.bold}Aborted.${c.reset} To use OAuth instead:`);
      console.log(`  ${c.bold}unset ${status.apiKeyEnvVar}${c.reset}`);
      console.log(`  ${c.bold}edward serve${c.reset}`);
      return false;
    }
  } else if (status.oauthAvailable === 'likely') {
    console.log(`${c.green}✓${c.reset}  OAuth login will be used (no ${status.apiKeyEnvVar} set)`);
  } else {
    console.log(`${c.red}✗${c.reset}  No OAuth credentials found and no ${status.apiKeyEnvVar} set.`);
    for (const line of status.suggestion.split('\n')) {
      console.log(`   ${c.dim}${line}${c.reset}`);
    }
    return false;
  }
  return true;
}

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  console.log(`${c.bold}edward doctor${c.reset}  ${c.dim}— preflight check${c.reset}\n`);

  const { provider: activeProvider, source } = resolveEffectiveProvider(args);
  const sourceLabel =
    source === 'flag' ? '--provider flag' :
    source === 'env'  ? 'EDWARD_PROVIDER env' :
    'default';
  console.log(`Active provider: ${c.bold}${activeProvider}${c.reset}  ${c.dim}(from ${sourceLabel})${c.reset}\n`);

  // Show both providers, marking the active one
  const claudeStatus = describeProviderAuth('claude');
  const codexStatus = describeProviderAuth('codex');

  const claudeUsable = renderProviderSection(claudeStatus, activeProvider === 'claude');
  console.log();
  const codexUsable = renderProviderSection(codexStatus, activeProvider === 'codex');

  console.log();
  // Diagnostics
  const activeUsable = activeProvider === 'claude' ? claudeUsable : codexUsable;
  if (activeUsable) {
    console.log(`${c.green}✓${c.reset}  Active provider (${activeProvider}) is ready.`);
  } else {
    console.log(`${c.red}✗${c.reset}  Active provider (${activeProvider}) is not usable. See above.`);
  }
  // Suggest fallback if the other provider is usable
  const otherProvider = activeProvider === 'claude' ? 'codex' : 'claude';
  const otherUsable = activeProvider === 'claude' ? codexUsable : claudeUsable;
  if (!activeUsable && otherUsable) {
    console.log(
      `${c.yellow}→${c.reset}  Fallback: ${c.bold}edward serve --provider ${otherProvider}${c.reset}  ` +
      `${c.dim}(or export EDWARD_PROVIDER=${otherProvider})${c.reset}`
    );
  }

  console.log();
  console.log(`Next: ${c.bold}edward serve${activeProvider !== 'claude' ? ` --provider ${activeProvider}` : ''}${c.reset}`);
}

// ── Commands ──

async function cmdServe(args: ParsedArgs): Promise<void> {
  // First-run gate: resolve the claude binary and confirm auth source
  // before binding to a port. Bails early on a fresh clone with a clear
  // message instead of crashing mid-discovery later.
  const ok = await preflightAuth(args);
  if (!ok) process.exit(1);

  const { startEdwardServer } = await import('./server.js');
  // Precedence: --port flag > EDWARD_PORT env > default 8080
  const port = args.port || parseInt(process.env.EDWARD_PORT || '8080', 10);
  try {
    startEdwardServer(port);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('in use') || msg.includes('EADDRINUSE')) {
      throw new Error(
        `Port ${port} is already in use.\n` +
        `       Try a different port: ${c.bold}edward serve --port ${port + 1}${c.reset}\n` +
        `       Or find the blocker:  ${c.bold}lsof -iTCP:${port} -sTCP:LISTEN${c.reset}`
      );
    }
    throw err;
  }
  console.log(`${c.dim}[edward] Serving on port ${port}. Press Ctrl+C to stop.${c.reset}`);
  // keep alive
  await new Promise(() => {});
}

async function cmdReposList(args: ParsedArgs): Promise<void> {
  const data = await api<{ repos: any[] }>(args.url, '/api/v1/repos');
  out(args, data.repos, () => {
    if (data.repos.length === 0) {
      console.log(`${c.dim}(no repos tracked)${c.reset}`);
      console.log(`Add one: ${c.bold}edward repos add owner/repo${c.reset}`);
      return;
    }
    console.log(`${c.bold}${padEnd('ID', 10)} ${padEnd('REPO', 40)} ${padEnd('LANGUAGE', 12)} ${'UPDATED'}${c.reset}`);
    for (const r of data.repos) {
      const id = c.dim + r.id.slice(0, 8) + c.reset;
      const name = c.bold + r.full_name + c.reset;
      const lang = r.language || '?';
      const updated = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : '-';
      console.log(`${padEnd(id, 10)} ${padEnd(name, 40)} ${padEnd(lang, 12)} ${updated}`);
    }
  });
}

async function cmdReposAdd(args: ParsedArgs): Promise<void> {
  const fullName = args._[2];
  if (!fullName || !fullName.includes('/')) {
    throw new Error('Usage: edward repos add owner/repo');
  }
  const data = await api<{ repo: any; created: boolean }>(
    args.url,
    '/api/v1/repos',
    { method: 'POST', body: JSON.stringify({ full_name: fullName }) }
  );
  out(args, data, () => {
    const status = data.created ? `${c.green}added${c.reset}` : `${c.yellow}already tracked${c.reset}`;
    console.log(`${status}  ${c.bold}${data.repo.full_name}${c.reset}  ${c.dim}id=${data.repo.id.slice(0, 8)}${c.reset}`);
    if (data.created) {
      console.log(`\nNext: ${c.bold}edward discover ${data.repo.full_name} --wait${c.reset}`);
    }
  });
}

// ── CI scorecard helpers ──

interface CIScorecardResponse {
  scorecard: {
    overall_score: number;
    verdict: string;
    provider: string;
    generated_at: string;
    dimensions: Record<string, { score: number; status: string; gaps: string[] }>;
    top_fixes: Array<{ title: string; effort_min: number; impact: string; why: string }>;
  } | null;
  generated_at: string | null;
}

function colorForCIScore(score: number, status: string): string {
  if (status === 'unverified' || status === 'na') return c.gray;
  if (score >= 8) return c.green;
  if (score >= 5) return c.yellow;
  return c.red;
}

function printCIScorecardSummary(sc: CIScorecardResponse['scorecard']): void {
  if (!sc) {
    console.log(`${c.dim}CI Health: not generated yet${c.reset}`);
    return;
  }
  const verdictCol =
    sc.verdict === 'comprehensive' ? c.green :
    sc.verdict === 'partial' ? c.yellow :
    c.red;
  console.log(`${c.bold}CI Health: ${sc.overall_score}/100${c.reset}  ${verdictCol}${sc.verdict}${c.reset}  ${c.dim}(${sc.provider})${c.reset}`);

  // 10 dimensions in two rows of 5 for terminal output
  const dimKeys = [
    'presence', 'triggers', 'build_stage', 'test_stage', 'lint_stage',
    'security_scan', 'branch_protection', 'deployment', 'hygiene', 'docs',
  ];
  const cells: string[] = [];
  for (const key of dimKeys) {
    const d = sc.dimensions?.[key];
    if (!d) {
      cells.push(`${c.gray}${padEnd(key, 12)} -/-${c.reset}`);
      continue;
    }
    const score = typeof d.score === 'number' ? d.score : 0;
    const col = colorForCIScore(score, d.status);
    const mark =
      d.status === 'pass' ? '✓' :
      d.status === 'partial' ? '⚠' :
      d.status === 'fail' ? '✗' :
      '?';
    // For unverified / na, show "—/—" rather than the meaningless raw 0 score
    const scoreText = (d.status === 'unverified' || d.status === 'na')
      ? '  —/—'
      : `${String(score).padStart(2)}/10`;
    cells.push(`${col}${mark} ${padEnd(key, 14)} ${scoreText}${c.reset}`);
  }
  // Print as two rows of 5
  for (let i = 0; i < cells.length; i += 5) {
    console.log('  ' + cells.slice(i, i + 5).join('  '));
  }

  if (sc.top_fixes && sc.top_fixes.length > 0) {
    console.log();
    console.log(`${c.dim}Top fixes:${c.reset}`);
    for (let i = 0; i < Math.min(sc.top_fixes.length, 3); i++) {
      const f = sc.top_fixes[i]!;
      const impactCol = f.impact === 'high' ? c.red : f.impact === 'medium' ? c.yellow : c.gray;
      console.log(`  ${i + 1}. ${c.bold}${f.title}${c.reset}  ${c.dim}(~${f.effort_min} min, ${impactCol}${f.impact}${c.reset}${c.dim} impact)${c.reset}`);
    }
  }
}

async function fetchScorecard(url: string, repoId: string): Promise<CIScorecardResponse['scorecard']> {
  try {
    const data = await api<CIScorecardResponse>(url, `/api/v1/repos/${repoId}/ci-scorecard`);
    return data.scorecard;
  } catch {
    return null;
  }
}

// ── Discover / ci-audit shared body ──

async function runDiscoverFlow(args: ParsedArgs, opts: { skipProduct: boolean }): Promise<void> {
  const query = args._[1];
  const verb = opts.skipProduct ? 'ci-audit' : 'discover';
  if (!query) throw new Error(`Usage: edward ${verb} <owner/repo> [--wait] [--provider claude|codex]`);
  const repo = await resolveRepo(args.url, query);

  // Pass through the effective provider via query param so the server
  // runs the discovery with the right LLM backend.
  const { provider, source } = resolveEffectiveProvider(args);
  const providerNote = source === 'default' ? '' : ` ${c.dim}(provider=${provider} from ${source === 'flag' ? '--provider' : 'EDWARD_PROVIDER'})${c.reset}`;

  console.log(`${c.dim}Triggering ${verb} for ${repo.full_name}...${c.reset}${providerNote}`);
  // Build URL with both skip_product and provider query params.
  const params = new URLSearchParams();
  if (opts.skipProduct) params.set('skip_product', '1');
  params.set('provider', provider);
  const discoverUrl = `/api/v1/repos/${repo.id}/discover?${params.toString()}`;
  const start = await api<{ message: string }>(
    args.url,
    discoverUrl,
    { method: 'POST' }
  );

  if (!args.wait) {
    console.log(`${c.green}✓${c.reset} ${start.message}`);
    console.log(`\nPoll status:  ${c.bold}edward ${verb} ${repo.full_name} --wait${c.reset}`);
    return;
  }

  // Wait for completion — poll every 10s, show a spinner
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  const t0 = Date.now();
  let lastCount = 0;

  const tick = setInterval(() => {
    if (!tty) return;
    const elapsed = Math.floor((Date.now() - t0) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    process.stdout.write(
      `\r${c.cyan}${spinner[frame++ % spinner.length]}${c.reset} analyzing... ${c.dim}[${mm}:${ss}]${c.reset}  ${c.dim}tasks so far: ${lastCount}${c.reset} `
    );
  }, 150);

  try {
    while (true) {
      await new Promise(r => setTimeout(r, 10_000));
      const status = await api<{ running: boolean; taskCount: number }>(
        args.url,
        `/api/v1/repos/${repo.id}/discover/status`
      );
      lastCount = status.taskCount;
      if (!status.running) break;
    }
  } finally {
    clearInterval(tick);
    if (tty) process.stdout.write('\r' + ' '.repeat(70) + '\r');
  }

  const elapsed = Math.floor((Date.now() - t0) / 1000);
  console.log(`${c.green}✓${c.reset} ${verb === 'ci-audit' ? 'CI audit' : 'Discovery'} complete in ${elapsed}s — ${lastCount} tasks`);
  console.log();

  // Show suggestions (skip if ci-audit and no findings — scorecard already covers it)
  await cmdSuggestions({ ...args, _: ['suggestions', query] });

  // Append CI scorecard summary (always — printCIScorecardSummary handles null)
  const sc = await fetchScorecard(args.url, repo.id);
  console.log();
  printCIScorecardSummary(sc);
}

async function cmdDiscover(args: ParsedArgs): Promise<void> {
  await runDiscoverFlow(args, { skipProduct: false });
}

async function cmdCiAudit(args: ParsedArgs): Promise<void> {
  await runDiscoverFlow(args, { skipProduct: true });
}

async function cmdSuggestions(args: ParsedArgs): Promise<void> {
  const query = args._[1];
  if (!query) throw new Error('Usage: edward suggestions <owner/repo>');
  const repo = await resolveRepo(args.url, query);
  const data = await api<{ suggestions: Array<{ task: any }> }>(
    args.url,
    `/api/v1/repos/${repo.id}/suggestions`
  );
  out(args, data.suggestions, () => {
    if (data.suggestions.length === 0) {
      console.log(`${c.dim}(no suggestions for ${repo.full_name})${c.reset}`);
      console.log(`Run: ${c.bold}edward discover ${repo.full_name} --wait${c.reset}`);
      return;
    }
    console.log(`${c.bold}Suggestions for ${repo.full_name}${c.reset}  ${c.dim}(${data.suggestions.length} open)${c.reset}`);
    console.log();
    for (let i = 0; i < data.suggestions.length; i++) {
      const t = data.suggestions[i]!.task;
      const typeCol = colorForType(t.type);
      const riskCol = colorForRisk(t.risk_level);
      const conf = Math.round(t.confidence * 100);
      const idShort = t.id.slice(0, 8);
      console.log(
        `${c.bold}${String(i + 1).padStart(2)}.${c.reset} ${typeCol}[${t.type}]${c.reset} ${c.bold}${t.title}${c.reset}`
      );
      console.log(
        `    ${c.dim}id=${idShort}${c.reset}  conf=${conf}%  risk=${riskCol}${t.risk_level}${c.reset}  files=${(t.impact?.estimatedFiles || []).length}`
      );
      const desc = truncate(String(t.description || '').split('\n')[0]!, 120);
      if (desc) console.log(`    ${c.dim}${desc}${c.reset}`);
      if (t.evidence?.userImpact) {
        console.log(`    ${c.yellow}→${c.reset} ${truncate(t.evidence.userImpact, 120)}`);
      }
      console.log();
    }
    console.log(`${c.dim}Next: edward approve <id>   |   edward dismiss <id>   |   edward snooze <id>${c.reset}`);
  });
}

async function cmdTasks(args: ParsedArgs): Promise<void> {
  const query = args._[1];
  if (!query) throw new Error('Usage: edward tasks <owner/repo>');
  const repo = await resolveRepo(args.url, query);
  const data = await api<{ tasks: any[]; count: number }>(args.url, `/api/v1/repos/${repo.id}/tasks`);
  out(args, data.tasks, () => {
    if (data.tasks.length === 0) {
      console.log(`${c.dim}(no tasks for ${repo.full_name})${c.reset}`);
      return;
    }
    console.log(`${c.bold}Tasks for ${repo.full_name}${c.reset}  ${c.dim}(${data.count} total)${c.reset}`);
    console.log();
    console.log(`${c.bold}${padEnd('ID', 10)} ${padEnd('STATUS', 12)} ${padEnd('TYPE', 22)} ${padEnd('RISK', 8)} CONF  TITLE${c.reset}`);
    for (const t of data.tasks) {
      const id = c.dim + t.id.slice(0, 8) + c.reset;
      const statusCol = colorForStatus(t.status);
      const status = statusCol + t.status + c.reset;
      const typeCol = colorForType(t.type);
      const type = typeCol + t.type + c.reset;
      const riskCol = colorForRisk(t.risk_level);
      const risk = riskCol + t.risk_level + c.reset;
      const conf = String(Math.round(t.confidence * 100)).padStart(3) + '%';
      const title = truncate(t.title, 60);
      console.log(
        `${padEnd(id, 10)} ${padEnd(status, 12)} ${padEnd(type, 22)} ${padEnd(risk, 8)} ${conf}  ${title}`
      );
    }
  });
}

async function cmdTaskAction(args: ParsedArgs, action: 'approve' | 'dismiss' | 'snooze'): Promise<void> {
  const query = args._[1];
  if (!query) throw new Error(`Usage: edward ${action} <task-id>`);
  const task = await resolveTask(args.url, query);
  const body: Record<string, unknown> = { action };
  if (action === 'dismiss' && args.reason) body.reason = args.reason;
  if (action === 'snooze' && args.until) body.snoozeUntil = args.until;

  const data = await api<any>(args.url, `/api/v1/tasks/${task.id}/action`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  out(args, data, () => {
    const col = action === 'approve' ? c.green : action === 'dismiss' ? c.red : c.gray;
    const verb = action === 'approve' ? 'approved' : action === 'dismiss' ? 'dismissed' : 'snoozed';
    console.log(`${col}✓${c.reset} ${verb}  ${c.bold}${truncate(task.title, 70)}${c.reset}  ${c.dim}id=${task.id.slice(0, 8)}${c.reset}`);
    if (data.execution) {
      console.log(`  ${c.dim}→ execution queued on branch ${data.execution.branch_name}${c.reset}`);
    }
    if (data.until) {
      console.log(`  ${c.dim}→ snoozed until ${data.until}${c.reset}`);
    }
  });
}

async function cmdStats(args: ParsedArgs): Promise<void> {
  const query = args._[1];
  if (!query) throw new Error('Usage: edward stats <owner/repo>');
  const repo = await resolveRepo(args.url, query);
  const data = await api<any>(args.url, `/api/v1/repos/${repo.id}/stats`);
  out(args, data, () => {
    console.log(`${c.bold}Stats for ${repo.full_name}${c.reset}  ${c.dim}(${data.period})${c.reset}`);
    console.log();
    const m = data.metrics || {};
    console.log(`  Suggested:  ${c.bold}${m.totalSuggested || 0}${c.reset}`);
    console.log(`  Accepted:   ${c.bold}${m.totalAccepted || 0}${c.reset}  ${c.dim}(${m.acceptanceRate || 0}%)${c.reset}`);
    console.log(`  Merged:     ${c.bold}${m.totalMerged || 0}${c.reset}  ${c.dim}(${m.mergeRate || 0}%)${c.reset}`);
    console.log();
    const tasks = data.tasks || {};
    if (Object.keys(tasks).length > 0) {
      console.log(`  ${c.dim}By status:${c.reset}`);
      for (const [k, v] of Object.entries(tasks)) {
        const col = colorForStatus(k);
        console.log(`    ${col}${padEnd(k, 14)}${c.reset} ${v}`);
      }
    }
  });
}

async function cmdExecutions(args: ParsedArgs): Promise<void> {
  const data = await api<{ executions: any[] }>(args.url, '/api/v1/executions');
  out(args, data.executions, () => {
    if (data.executions.length === 0) {
      console.log(`${c.dim}(no executions)${c.reset}`);
      return;
    }
    console.log(`${c.bold}${padEnd('ID', 10)} ${padEnd('STATUS', 12)} ${padEnd('BRANCH', 40)} CREATED${c.reset}`);
    for (const e of data.executions) {
      const id = c.dim + e.id.slice(0, 8) + c.reset;
      const statusCol = colorForStatus(e.status);
      const status = statusCol + e.status + c.reset;
      const created = e.created_at ? new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ') : '-';
      console.log(`${padEnd(id, 10)} ${padEnd(status, 12)} ${padEnd(e.branch_name, 40)} ${created}`);
    }
  });
}

function cmdHelp(): void {
  const b = c.bold, d = c.dim, r = c.reset;
  console.log(`${b}edward${r} — proactive agent for repo maintenance  ${d}(Repo Steward v0.4)${r}

${b}USAGE${r}
  edward <command> [args] [flags]

${b}COMMANDS${r}
  ${b}serve${r} [--port N] [--yes] [--provider]   Start the dashboard server
  ${b}doctor${r}                                   Preflight: check both claude + codex providers

  ${b}repos${r}                            List tracked repos
  ${b}repos add${r} owner/repo             Add a repo (fetches GitHub metadata)

  ${b}discover${r} <repo> [--wait] [--provider]   Trigger agent analysis (async unless --wait)
  ${b}ci-audit${r} <repo> [--wait] [--provider]   CI completeness audit only (faster, no product bug scan)
  ${b}suggestions${r} <repo>               Top 10 open suggestions for a repo
  ${b}tasks${r} <repo>                     All tasks (any status)
  ${b}stats${r} <repo>                     Acceptance rate, merge rate, counts

  ${b}approve${r} <task>                   Approve → queue execution
  ${b}dismiss${r} <task> [--reason "..."]  Dismiss a task
  ${b}snooze${r}  <task> [--until ISO]     Snooze a task (default 24h)

  ${b}executions${r}                       List queued / running executions
  ${b}version${r}                          Print version

${b}FLAGS${r}
  --json                           Emit raw JSON (pipeable)
  --url URL                        Override EDWARD_URL (default http://localhost:8080)
  --port N, -p N                   Port for 'edward serve' (default 8080)
  --wait                           Block until discovery finishes (for discover)
  --yes, -y                        Skip interactive confirmation (for serve)
  --provider claude|codex          LLM backend to use (default: claude; codex = GPT via ChatGPT OAuth)
  --reason "..."                   Reason for dismiss
  --until ISO                      ISO timestamp for snooze

${b}EXAMPLES${r}
  edward serve                      # default: claude provider
  edward serve --provider codex     # use codex (GPT) instead of claude
  edward doctor                     # check both provider availability
  edward repos add teamo-lab/clawschool
  edward discover teamo-lab/clawschool --wait
  edward discover teamo-lab/clawschool --wait --provider codex
  edward suggestions teamo-lab/clawschool
  edward approve a1b2c3d4
  edward dismiss a1b2c3d4 --reason "won't fix"
  edward tasks teamo-lab/clawschool --json | jq '.[] | select(.risk_level=="high")'

${b}ENVIRONMENT${r}
  EDWARD_URL         Server URL for CLI commands (default: http://localhost:8080)
  EDWARD_PORT        Port for 'edward serve' (default: 8080)
  EDWARD_PROVIDER    Default LLM provider (claude|codex). Overridden by --provider flag.
  CLAUDE_BIN         Override auto-detection of the \`claude\` CLI binary
  CODEX_BIN          Override auto-detection of the \`codex\` CLI binary
  ANTHROPIC_API_KEY  If set, claude runs bill to that API account instead of OAuth.
  OPENAI_API_KEY     If set, codex runs bill to that API account instead of ChatGPT OAuth.

${d}A repo argument accepts either 'owner/repo' or a UUID prefix.${r}
${d}A task argument accepts a UUID prefix (8 chars is usually enough).${r}
`);
}

// ── Main dispatch ──

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const sub = args._[1];

  if (args.help || !cmd || cmd === 'help') {
    cmdHelp();
    return 0;
  }

  try {
    switch (cmd) {
      case 'serve':
        await cmdServe(args);
        return 0;

      case 'doctor':
        await cmdDoctor(args);
        return 0;

      case 'version':
      case '--version':
      case '-v':
        console.log('edward 0.4.0  (bun + claude CLI subprocess)');
        return 0;

      case 'repos':
        if (!sub || sub === 'list') { await cmdReposList(args); return 0; }
        if (sub === 'add') { await cmdReposAdd(args); return 0; }
        throw new Error(`Unknown 'repos' subcommand: ${sub}`);

      case 'discover':
        await cmdDiscover(args);
        return 0;

      case 'ci-audit':
      case 'ci_audit':
        await cmdCiAudit(args);
        return 0;

      case 'suggestions':
      case 'suggest':
        await cmdSuggestions(args);
        return 0;

      case 'tasks':
        await cmdTasks(args);
        return 0;

      case 'approve':
        await cmdTaskAction(args, 'approve');
        return 0;

      case 'dismiss':
        await cmdTaskAction(args, 'dismiss');
        return 0;

      case 'snooze':
        await cmdTaskAction(args, 'snooze');
        return 0;

      case 'stats':
        await cmdStats(args);
        return 0;

      case 'executions':
      case 'exec':
        await cmdExecutions(args);
        return 0;

      default:
        console.error(`${c.red}error:${c.reset} unknown command '${cmd}'`);
        console.error(`Run ${c.bold}edward help${c.reset} for usage.`);
        return 1;
    }
  } catch (err: any) {
    console.error(`${c.red}error:${c.reset} ${err.message}`);
    return 1;
  }
}
