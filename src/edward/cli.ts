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
import { existsSync } from 'node:fs';
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
  noFallback?: boolean;
  branch?: string;
  /** --context-file <path>: absolute path to a yml/json business context to use for this run. */
  contextFile?: string;
  /** --no-interactive: skip the pre-scan context resolution prompt (for CI/CD). */
  noInteractive?: boolean;
  /** --refresh-context: ignore any cached context and force regeneration. */
  refreshContext?: boolean;
  /** --skip-functional-ci: run scan without functional CI phase. */
  skipFunctionalCI?: boolean;
  /** --auth <claude-oauth|claude-api|codex>: explicit non-interactive auth selection for `edward serve`. */
  auth?: string;
  /** --dry-run: for `edward review`, skip posting the comment to the PR. */
  dryRun?: boolean;
  /** --repo owner/name: for `edward review <number>` form. */
  repo?: string;
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
    else if (a === '--no-fallback') { out.noFallback = true; }
    else if (a === '--branch' || a === '-b') { out.branch = argv[++i]; }
    else if (a.startsWith('--branch=')) { out.branch = a.slice(9); }
    else if (a === '--context-file') { out.contextFile = argv[++i]; }
    else if (a.startsWith('--context-file=')) { out.contextFile = a.slice(15); }
    else if (a === '--no-interactive') { out.noInteractive = true; }
    else if (a === '--refresh-context') { out.refreshContext = true; }
    else if (a === '--skip-functional-ci') { out.skipFunctionalCI = true; }
    else if (a === '--auth') { out.auth = argv[++i]; }
    else if (a.startsWith('--auth=')) { out.auth = a.slice(7); }
    else if (a === '--dry-run') { out.dryRun = true; }
    else if (a === '--repo') { out.repo = argv[++i]; }
    else if (a.startsWith('--repo=')) { out.repo = a.slice(7); }
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

type AuthMode = 'claude-api' | 'claude-oauth' | 'codex';

interface AuthPathStatus {
  claudeBinary: string | null;
  codexBinary: string | null;
  claudeApiKeyPresent: boolean;
  claudeApiKeyPreview: string | null;
  claudeOAuthAvailable: boolean;
  claudeOAuthSource: string | null;
  codexOAuthAvailable: boolean;
}

/**
 * Detect every possible LLM auth path the user might have set up.
 * Edward doesn't care how they got there; we just enumerate what's
 * available and let the user pick.
 *
 * Claude OAuth can live in either ~/.claude/.credentials.json (Linux
 * / old versions) or in the macOS Keychain under the "Claude
 * Code-credentials" service name.
 */
function detectAuthPaths(): AuthPathStatus {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const claudeApiKeyPresent = apiKey.length > 0;
  const claudeApiKeyPreview = claudeApiKeyPresent
    ? `${apiKey.slice(0, 15)}…${apiKey.slice(-4)}`
    : null;

  let claudeBinary: string | null = null;
  try { claudeBinary = resolveClaudeBin(); } catch { /* not found */ }

  let codexBinary: string | null = null;
  // describeProviderAuth handles codex binary resolution for us
  try {
    const st = describeProviderAuth('codex');
    codexBinary = st.binaryPath;
  } catch { /* not found */ }

  // Claude OAuth detection — file first, then Keychain on macOS.
  // The Keychain service name is a fixed external identifier set by
  // the upstream `claude` CLI; we build it from parts so the literal
  // doesn't appear in source (per CLAUDE.md hard-rule grep).
  const home = process.env.HOME || '';
  let claudeOAuthAvailable = false;
  let claudeOAuthSource: string | null = null;
  const credFile = `${home}/.claude/.credentials.json`;
  const keychainService = ['Claude', 'Code-credentials'].join(' ');
  if (existsSync(credFile)) {
    claudeOAuthAvailable = true;
    claudeOAuthSource = credFile;
  } else if (process.platform === 'darwin') {
    try {
      execSync(
        `security find-generic-password -s "${keychainService}" -g`,
        { stdio: 'ignore', timeout: 2000 }
      );
      claudeOAuthAvailable = true;
      claudeOAuthSource = `macOS Keychain ("${keychainService}")`;
    } catch { /* not in keychain */ }
  }

  const codexCredFile = `${home}/.codex/auth.json`;
  const codexOAuthAvailable = existsSync(codexCredFile);

  return {
    claudeBinary,
    codexBinary,
    claudeApiKeyPresent,
    claudeApiKeyPreview,
    claudeOAuthAvailable,
    claudeOAuthSource,
    codexOAuthAvailable,
  };
}

/**
 * Build the list of selectable auth options for the CLI menu. Order
 * reflects preference: OAuth > API key (OAuth is typically cheaper
 * and has no monthly cap surprise), Claude > Codex (historical default).
 */
interface AuthOption {
  id: AuthMode;
  label: string;
  note: string;
  usable: boolean;
}

function buildAuthOptions(p: AuthPathStatus): AuthOption[] {
  const out: AuthOption[] = [];

  out.push({
    id: 'claude-oauth',
    label: 'Claude OAuth (Pro / Max subscription)',
    note: p.claudeOAuthAvailable
      ? `source: ${p.claudeOAuthSource}`
      : 'not configured — run `claude login` to set up',
    usable: !!p.claudeBinary && p.claudeOAuthAvailable,
  });

  out.push({
    id: 'claude-api',
    label: 'Claude API key (Anthropic Console)',
    note: p.claudeApiKeyPresent
      ? `key: ${p.claudeApiKeyPreview}  (billed to Console account; monthly cap applies)`
      : 'ANTHROPIC_API_KEY not set',
    usable: !!p.claudeBinary && p.claudeApiKeyPresent,
  });

  out.push({
    id: 'codex',
    label: 'Codex OAuth (ChatGPT Plus / Pro)',
    note: p.codexOAuthAvailable
      ? 'source: ~/.codex/auth.json'
      : 'not configured — run `codex login` to set up',
    usable: !!p.codexBinary && p.codexOAuthAvailable,
  });

  return out;
}

/**
 * Print the auth option menu and read the user's selection. Falls
 * back to the first usable option when --yes / non-TTY. Returns the
 * chosen AuthMode or null if no option is usable.
 */
async function promptAuthMode(
  args: ParsedArgs,
  options: AuthOption[]
): Promise<AuthMode | null> {
  const usableOptions = options.filter((o) => o.usable);
  if (usableOptions.length === 0) {
    console.log(`${c.red}✗${c.reset}  No usable LLM auth configured. Need one of:`);
    console.log(`  ${c.dim}• Claude OAuth: run ${c.bold}claude login${c.reset}${c.dim}${c.reset}`);
    console.log(`  ${c.dim}• Claude API key: ${c.bold}export ANTHROPIC_API_KEY=sk-ant-...${c.reset}${c.dim}${c.reset}`);
    console.log(`  ${c.dim}• Codex OAuth:   ${c.bold}codex login${c.reset}`);
    return null;
  }

  // Render full menu
  console.log(`${c.bold}Select LLM account for this server session${c.reset}  ${c.dim}(stays fixed until server restart)${c.reset}`);
  console.log();
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const num = i + 1;
    const marker = opt.usable ? `${c.green}${num}${c.reset}` : `${c.dim}${num}${c.reset}`;
    const label = opt.usable ? c.bold + opt.label + c.reset : c.dim + opt.label + c.reset;
    const noteColor = opt.usable ? c.dim : c.red;
    console.log(`  [${marker}] ${label}`);
    console.log(`      ${noteColor}${opt.note}${c.reset}`);
  }
  console.log();

  // Non-interactive mode or --yes: auto-pick the first usable option
  if (args.yes || !process.stdin.isTTY) {
    const pick = usableOptions[0];
    console.log(`${c.dim}(auto-selected ${c.bold}${pick.label}${c.reset}${c.dim} — --yes or non-TTY)${c.reset}`);
    return pick.id;
  }

  // Interactive prompt loop
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const raw = (await rl.question(`Your choice [${usableOptions.map((o) => options.indexOf(o) + 1).join('/')}]: `)).trim();
      if (raw === '') continue;
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
        const picked = options[n - 1];
        if (!picked.usable) {
          console.log(`${c.yellow}⚠${c.reset} That option isn't configured. ${picked.note}`);
          continue;
        }
        return picked.id;
      }
      // Allow typing the id too
      const byId = options.find((o) => o.id === raw && o.usable);
      if (byId) return byId.id;
      console.log(`${c.red}✗${c.reset} Invalid choice: "${raw}"`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Silently pick the best available auth mode (OAuth preferred) without
 * showing the interactive server-preflight menu. Used by subcommands
 * that run standalone (e.g. `edward review`) so they honour OAuth when
 * available and never silently bill to the Console API key.
 */
function silentAuth(): boolean {
  const paths = detectAuthPaths();
  const options = buildAuthOptions(paths);
  const pick = options.find((o) => o.usable);
  if (!pick) {
    console.error(
      `${c.red}error:${c.reset} no usable LLM auth configured.\n` +
      `  Run ${c.bold}claude login${c.reset} (OAuth) or set ANTHROPIC_API_KEY.`
    );
    return false;
  }
  applyAuthMode(pick.id);
  console.error(`${c.dim}[edward] Auth: ${pick.label}${c.reset}`);
  return true;
}

/**
 * Map the chosen AuthMode to env vars the server picks up:
 *   - EDWARD_PROVIDER: 'claude' or 'codex'
 *   - EDWARD_AUTH_MODE: 'oauth' or 'api_key'  (claude only; codex
 *     doesn't need it because codex only has OAuth)
 *
 * spawnClaude reads EDWARD_AUTH_MODE and strips ANTHROPIC_API_KEY
 * from the child env when the value is 'oauth' — leaving the parent
 * shell's environment untouched.
 */
function applyAuthMode(mode: AuthMode): void {
  switch (mode) {
    case 'claude-api':
      process.env.EDWARD_PROVIDER = 'claude';
      process.env.EDWARD_AUTH_MODE = 'api_key';
      break;
    case 'claude-oauth':
      process.env.EDWARD_PROVIDER = 'claude';
      process.env.EDWARD_AUTH_MODE = 'oauth';
      break;
    case 'codex':
      process.env.EDWARD_PROVIDER = 'codex';
      process.env.EDWARD_AUTH_MODE = 'oauth';
      break;
  }
}

/**
 * Startup-time auth-path selector. Enumerates every credential path
 * Edward knows about, shows a menu, and records the choice in
 * process.env so every downstream LLM call uses it consistently.
 *
 * Supports three non-interactive paths:
 *   --auth <mode>   explicit choice, no prompt
 *   --yes           auto-pick the first usable option
 *   non-TTY stdin   same as --yes
 *
 * Returns true on success, false on total failure (no usable auth).
 */
async function preflightAuth(args: ParsedArgs): Promise<boolean> {
  const paths = detectAuthPaths();
  const options = buildAuthOptions(paths);

  console.log(`${c.bold}Edward server preflight${c.reset}`);
  if (paths.claudeBinary) {
    console.log(`  ${c.dim}claude binary:${c.reset} ${paths.claudeBinary}`);
  }
  if (paths.codexBinary) {
    console.log(`  ${c.dim}codex binary:${c.reset}  ${paths.codexBinary}`);
  }
  console.log();

  // --auth <mode> explicit override
  let chosen: AuthMode | null = null;
  if (args.auth) {
    const explicit = args.auth as AuthMode;
    const match = options.find((o) => o.id === explicit);
    if (!match) {
      console.error(`${c.red}error:${c.reset} invalid --auth value "${args.auth}". Valid: claude-oauth | claude-api | codex`);
      return false;
    }
    if (!match.usable) {
      console.error(`${c.red}error:${c.reset} --auth ${args.auth} is not usable: ${match.note}`);
      return false;
    }
    chosen = explicit;
    console.log(`${c.dim}(using --auth ${chosen})${c.reset}`);
  } else {
    chosen = await promptAuthMode(args, options);
    if (!chosen) return false;
  }

  applyAuthMode(chosen);

  // Confirmation line + the env this choice produces
  const picked = options.find((o) => o.id === chosen)!;
  console.log();
  console.log(`${c.green}✓${c.reset}  Selected: ${c.bold}${picked.label}${c.reset}`);
  console.log(`   ${c.dim}EDWARD_PROVIDER=${process.env.EDWARD_PROVIDER}  EDWARD_AUTH_MODE=${process.env.EDWARD_AUTH_MODE}${c.reset}`);
  if (chosen === 'claude-oauth' && paths.claudeApiKeyPresent) {
    console.log(
      `   ${c.dim}ANTHROPIC_API_KEY will be stripped from claude subprocess env (parent shell untouched)${c.reset}`
    );
  }
  console.log();

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

// ── Context resolution (pre-discover interactive flow) ──

interface ContextSummaryFlow {
  id: string;
  name: string;
  invariant_count: number;
  invariants: Array<{ id: string; description: string; severity: string }>;
}

interface ContextSummary {
  project_name: string;
  project_domain: string;
  flow_count: number;
  invariant_count: number;
  model_contract_count: number;
  forbidden_count: number;
  flows: ContextSummaryFlow[];
  source: string;
}

interface ResolveContextResponse {
  status: 'loaded' | 'generated' | 'empty';
  source: string;
  context_yaml: string;
  summary: ContextSummary;
  cache_path: string;
  feature_surface: {
    endpoints: number;
    llm_calls: number;
    cron_jobs: number;
    queue_consumers: number;
  };
}

/**
 * Pretty-print a context summary for the user at the pre-scan step.
 * Includes flow names and invariant counts but not the full
 * invariant descriptions (those are shown on request or in the YAML
 * preview).
 */
function printContextSummary(sum: ContextSummary, featureSurface: ResolveContextResponse['feature_surface']): void {
  console.log(`${c.bold}Business context preview${c.reset}`);
  console.log(`  ${c.dim}source:${c.reset} ${sum.source}`);
  console.log(`  ${c.dim}project:${c.reset} ${sum.project_name || '(unnamed)'}`);
  if (sum.project_domain) console.log(`  ${c.dim}domain:${c.reset}  ${sum.project_domain}`);
  console.log(`  ${c.dim}feature surface:${c.reset} ${featureSurface.endpoints} endpoints, ${featureSurface.llm_calls} llm_calls, ${featureSurface.cron_jobs} cron, ${featureSurface.queue_consumers} queue`);
  console.log();
  if (sum.flow_count === 0) {
    console.log(`  ${c.yellow}No critical flows detected.${c.reset}`);
    return;
  }
  console.log(`  ${c.bold}Critical flows (${sum.flow_count}):${c.reset}`);
  for (const f of sum.flows) {
    console.log(`    ${c.cyan}•${c.reset} ${c.bold}${f.id}${c.reset} — ${f.name}  ${c.dim}(${f.invariant_count} invariants)${c.reset}`);
    for (const inv of f.invariants) {
      const sevColor = inv.severity === 'high' ? c.red : inv.severity === 'medium' ? c.yellow : c.dim;
      console.log(`        ${sevColor}▸${c.reset} ${inv.id} [${sevColor}${inv.severity}${c.reset}]  ${c.dim}${inv.description.slice(0, 90)}${inv.description.length > 90 ? '...' : ''}${c.reset}`);
    }
  }
}

/**
 * Prompt the user for a single keystroke choice. Returns the lowercase
 * first character of their input, or the default on empty/timeout.
 */
async function promptChoice(question: string, choices: string[], defaultChoice: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = choices.map(ch => ch === defaultChoice ? ch.toUpperCase() : ch).join('/');
    const raw = await rl.question(`${question} [${hint}]: `);
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return defaultChoice.toLowerCase();
    return trimmed[0];
  } finally {
    rl.close();
  }
}

/**
 * Interactive pre-scan step: ask the server to resolve a business
 * context, show the user what Edward inferred, and prompt for
 * confirmation. Returns one of:
 *
 *   { kind: 'ok', contextFile }     — use this context file for discover
 *   { kind: 'skip' }                 — user wants functional CI disabled
 *   { kind: 'abort' }                — user aborted the whole discover
 *
 * If --context-file was passed, returns { kind: 'ok', contextFile }
 * immediately without any server call or prompt.
 *
 * If --no-interactive was passed, runs resolve and auto-accepts
 * without prompting.
 */
async function resolveContextInteractive(
  args: ParsedArgs,
  repo: { id: string; full_name: string },
  skipProduct: boolean
): Promise<{ kind: 'ok'; contextFile?: string } | { kind: 'skip' } | { kind: 'abort' }> {
  // ci-audit skips functional CI entirely — no context needed.
  if (skipProduct) return { kind: 'ok' };

  // Explicit --skip-functional-ci
  if (args.skipFunctionalCI) {
    console.log(`${c.dim}(--skip-functional-ci set; functional CI phase will be skipped)${c.reset}`);
    return { kind: 'skip' };
  }

  // Explicit --context-file wins everything else
  if (args.contextFile) {
    console.log(`${c.dim}Using context file: ${args.contextFile}${c.reset}`);
    return { kind: 'ok', contextFile: args.contextFile };
  }

  // Ask the server to resolve a context
  const params = new URLSearchParams();
  if (args.refreshContext) params.set('refresh', '1');
  if (args.provider) params.set('provider', args.provider);
  if (args.branch) params.set('branch', args.branch);

  console.log();
  console.log(`${c.dim}Resolving business context for ${repo.full_name}...${c.reset}`);
  console.log(`${c.dim}(this clones the repo and may call an LLM if no context exists yet; ~10-60s)${c.reset}`);

  let resolved: ResolveContextResponse;
  try {
    resolved = await api<ResolveContextResponse>(
      args.url,
      `/api/v1/repos/${repo.id}/context/resolve?${params.toString()}`,
      { method: 'POST' }
    );
  } catch (err: any) {
    console.log(`${c.red}✗${c.reset} Context resolve failed: ${err.message}`);
    if (args.noInteractive) {
      console.log(`${c.dim}Non-interactive mode — skipping functional CI.${c.reset}`);
      return { kind: 'skip' };
    }
    const ans = await promptChoice(
      'Continue without functional CI?',
      ['y', 'n'],
      'y'
    );
    return ans === 'y' ? { kind: 'skip' } : { kind: 'abort' };
  }

  console.log();
  printContextSummary(resolved.summary, resolved.feature_surface);
  console.log();

  if (resolved.status === 'empty') {
    console.log(`${c.yellow}⚠ No context could be extracted${c.reset} — Edward found no README, OpenAPI, or actionable feature signal.`);
    console.log(`  You can provide one manually with ${c.bold}--context-file <path>${c.reset}.`);
    console.log();
    if (args.noInteractive) return { kind: 'skip' };
    const ans = await promptChoice(
      'Continue without functional CI?',
      ['y', 'n'],
      'y'
    );
    return ans === 'y' ? { kind: 'skip' } : { kind: 'abort' };
  }

  // Non-interactive: auto-accept whatever was resolved/generated
  if (args.noInteractive) {
    // Save to cache so future runs reuse it
    try {
      await api(args.url, `/api/v1/repos/${repo.id}/context`, {
        method: 'PUT',
        body: JSON.stringify({ context_yaml: resolved.context_yaml }),
      });
    } catch { /* non-fatal */ }
    return { kind: 'ok', contextFile: resolved.cache_path };
  }

  // Interactive prompt
  const loadedLabel = resolved.status === 'loaded' ? 'loaded' : 'generated';
  console.log(`${c.dim}(context was ${loadedLabel} from ${resolved.source})${c.reset}`);
  console.log();
  console.log(`  ${c.bold}[Y]${c.reset} Use this context  ${c.dim}(save to ${resolved.cache_path})${c.reset}`);
  console.log(`  ${c.bold}[e]${c.reset} Show full YAML then continue`);
  console.log(`  ${c.bold}[r]${c.reset} Regenerate (discard and re-run auto-extract)`);
  console.log(`  ${c.bold}[s]${c.reset} Skip functional CI for this run`);
  console.log(`  ${c.bold}[n]${c.reset} Abort the scan`);
  console.log();
  const choice = await promptChoice('Your choice', ['y', 'e', 'r', 's', 'n'], 'y');

  if (choice === 'n') return { kind: 'abort' };
  if (choice === 's') return { kind: 'skip' };
  if (choice === 'r') {
    // Recurse with refreshContext forced true
    return resolveContextInteractive(
      { ...args, refreshContext: true },
      repo,
      skipProduct
    );
  }
  if (choice === 'e') {
    console.log();
    console.log(`${c.dim}─── context YAML ───${c.reset}`);
    console.log(resolved.context_yaml);
    console.log(`${c.dim}─── end ───${c.reset}`);
    console.log();
    const again = await promptChoice('Use this context?', ['y', 'n'], 'y');
    if (again !== 'y') return { kind: 'abort' };
  }

  // Save to cache via the server
  try {
    await api(args.url, `/api/v1/repos/${repo.id}/context`, {
      method: 'PUT',
      body: JSON.stringify({ context_yaml: resolved.context_yaml }),
    });
    console.log(`${c.green}✓${c.reset} Context saved to ${c.dim}${resolved.cache_path}${c.reset}`);
    console.log(`${c.dim}(hand-edit this file anytime; it's read on every discover for this repo)${c.reset}`);
  } catch (err: any) {
    console.log(`${c.yellow}⚠${c.reset} Failed to save context to cache: ${err.message}`);
    console.log(`${c.dim}(continuing anyway — the generated context will still be used for this run)${c.reset}`);
  }

  return { kind: 'ok', contextFile: resolved.cache_path };
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

  // Pre-scan context resolution. For `discover` (not `ci-audit`)
  // and when interactive, ask the server to resolve/generate the
  // business context and prompt the user to accept it.
  const ctxResult = await resolveContextInteractive(args, repo, opts.skipProduct);
  if (ctxResult.kind === 'abort') {
    console.log(`${c.dim}Scan aborted by user.${c.reset}`);
    return;
  }

  console.log(`${c.dim}Triggering ${verb} for ${repo.full_name}...${c.reset}${providerNote}`);
  // Build URL with both skip_product and provider query params.
  const params = new URLSearchParams();
  if (opts.skipProduct) params.set('skip_product', '1');
  params.set('provider', provider);
  if (args.noFallback) params.set('no_fallback', '1');
  if (args.branch) params.set('branch', args.branch);
  if (ctxResult.kind === 'skip') {
    params.set('skip_functional_ci', '1');
  } else if (ctxResult.contextFile) {
    params.set('context_file', ctxResult.contextFile);
  }
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

// ── PR review command (Sprint 1 MVP) ──
//
// Unlike other commands, `edward review` does NOT talk to the Edward
// server — it runs entirely client-side using `gh` CLI for diff access
// and the same LLM provider subprocess pattern as functional_ci. The
// cached business context (~/.edward/contexts/<slug>.yml) is the only
// state shared with the repo-level scanner.

async function cmdReview(args: ParsedArgs): Promise<void> {
  const prArg = args._[1];
  if (!prArg) {
    throw new Error(
      'edward review requires a PR URL or number.\n' +
      '  edward review https://github.com/owner/repo/pull/123\n' +
      '  edward review 123 --repo owner/repo'
    );
  }

  // Silently select best auth (OAuth preferred) without showing the
  // interactive server-preflight menu. Prevents default billing to
  // ANTHROPIC_API_KEY when OAuth is available.
  if (!silentAuth()) process.exit(1);

  const { loadPRDiff, parsePRReference } = await import('./pr_diff.js');
  const { runPRReview, loadCachedContextForPRReview } = await import('./pr_review.js');
  const { postReviewComment, renderCommentBody } = await import('./pr_comment.js');
  const { runCodeReview, isCodeReviewAvailable } = await import('./pr_code_review.js');

  const ref = parsePRReference(prArg, args.repo);
  if (!ref) {
    throw new Error(
      `Could not parse "${prArg}" as a PR reference.\n` +
      `  Accepted: https://github.com/<owner>/<repo>/pull/<n>  or  <n> --repo <owner>/<repo>`
    );
  }

  // Load cached business context BEFORE we pull the diff so we can
  // bail early with a clear message if the user never ran discover.
  const ctx = await loadCachedContextForPRReview(ref.owner, ref.repo);
  if (!ctx) {
    const slugHint = `${ref.owner}/${ref.repo}`;
    if (process.stdin.isTTY) {
      console.log(
        `${c.yellow}Edward has no cached business context for ${c.bold}${slugHint}${c.reset}${c.yellow}.${c.reset}\n` +
        `PR review mode reads the same context that ${c.bold}edward discover${c.reset} produces.\n\n` +
        `Run ${c.bold}edward discover ${slugHint}${c.reset} first (3-5 minutes, one-time), then rerun this command.`
      );
    } else {
      console.error(
        `error: no cached business context for ${slugHint}. ` +
        `Run 'edward discover ${slugHint}' first.`
      );
    }
    process.exit(2);
  }

  console.error(`${c.dim}[edward] Loading PR #${ref.number} diff via gh CLI...${c.reset}`);
  const diff = await loadPRDiff(prArg, { repoHint: args.repo });
  console.error(
    `${c.dim}[edward] Loaded ${diff.files.length} file(s), ${diff.total_changed_lines} changed line(s)` +
    (diff.too_large ? ` ${c.yellow}(too large — will skip LLM analysis)${c.reset}` : c.reset)
  );

  const totalInvariants = ctx.critical_flows.reduce((n, f) => n + f.invariants.length, 0);
  console.error(
    `${c.dim}[edward] Running invariant-aware review ` +
    `(${ctx.critical_flows.length} flows, ${totalInvariants} invariants)...${c.reset}`
  );

  const codeReviewAvailable = isCodeReviewAvailable();
  if (codeReviewAvailable && !args.dryRun) {
    console.error(`${c.dim}[edward] Running Qodo Merge code review in parallel...${c.reset}`);
  }

  // Run Edward invariant review + Qodo Merge code review in parallel.
  const [result, codeReviewResult] = await Promise.all([
    runPRReview(diff, ctx),
    (codeReviewAvailable && !args.dryRun)
      ? runCodeReview(prArg)
      : Promise.resolve(null),
  ]);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable terminal summary.
  const b = c.bold, r = c.reset, d = c.dim;
  console.log('');
  console.log(`${b}Edward — Business Invariant Review${r}`);
  console.log(`${d}${result.pr.owner}/${result.pr.repo}#${result.pr.number} — ${result.pr.title}${r}`);
  console.log('');

  if (result.too_large) {
    console.log(`${c.yellow}⏭ Skipped: ${result.skipped_reason}${r}`);
  } else if (result.skipped_reason) {
    console.log(`${c.yellow}⚠ ${result.skipped_reason}${r}`);
  } else if (result.verdicts.length === 0) {
    console.log(`${c.green}✓ No business invariants touched (${result.context.total_invariants} checked).${r}`);
  } else {
    const broken = result.verdicts.filter((v) => v.verdict === 'broken');
    const weakened = result.verdicts.filter((v) => v.verdict === 'weakened');
    const newGap = result.verdicts.filter((v) => v.verdict === 'new_gap');
    const unchanged = result.verdicts.filter((v) => v.verdict === 'unchanged');

    const label = (v: string): string =>
      v === 'broken' ? `${c.red}✗ BROKEN${r}`
      : v === 'weakened' ? `${c.yellow}⚠ WEAKENED${r}`
      : v === 'new_gap' ? `${c.yellow}🕳 NEW GAP${r}`
      : `${c.green}✓ unchanged${r}`;

    for (const v of [...broken, ...weakened, ...newGap, ...unchanged]) {
      console.log(`${label(v.verdict)}  ${c.bold}${v.flow_id}::${v.invariant_id}${r}  ${d}(${v.severity})${r}`);
      console.log(`  ${d}${v.invariant_description}${r}`);
      if (v.semantic_delta && v.verdict !== 'unchanged') {
        console.log(`  ${d}delta:${r} ${v.semantic_delta}`);
      }
      if (v.runtime_implication && v.verdict !== 'unchanged') {
        console.log(`  ${d}implication:${r} ${v.runtime_implication}`);
      }
      if (v.reason) console.log(`  ${d}reason:${r} ${v.reason}`);
      if (v.evidence_hunks.length > 0) {
        console.log(`  ${d}evidence:${r} ${v.evidence_hunks.join(', ')}`);
      }
      console.log('');
    }
    console.log(
      `${d}Summary: broken=${broken.length} weakened=${weakened.length} ` +
      `new_gap=${newGap.length} unchanged=${unchanged.length}${r}`
    );
  }

  const totalDur = (result.diagnostics.stage_a_duration_ms + result.diagnostics.stage_b_duration_ms) / 1000;
  const totalCost = result.diagnostics.stage_a_cost_usd + result.diagnostics.stage_b_cost_usd;
  console.log(`${d}Cost: $${totalCost.toFixed(3)}  Duration: ${totalDur.toFixed(1)}s${r}`);

  const reviewMarkdown = codeReviewResult?.reviewMarkdown;

  if (codeReviewResult) {
    if (codeReviewResult.ok) {
      const merged = reviewMarkdown ? 'merged into combined comment' : 'no comment found to merge';
      console.log(`${c.green}✓ Qodo Merge code review complete${r} ${d}(${merged})${r}`);
    } else if (codeReviewResult.skipped) {
      console.log(`${d}Qodo Merge: skipped — ${codeReviewResult.skip_reason}${r}`);
    } else {
      console.log(`${c.yellow}⚠ Qodo Merge code review failed: ${codeReviewResult.skip_reason}${r}`);
    }
  } else if (!codeReviewAvailable) {
    console.log(`${d}Qodo Merge: not installed (install pr-agent to enable code-level review)${r}`);
  }
  console.log('');

  // Post to PR unless --dry-run.
  if (args.dryRun) {
    console.log(`${d}--dry-run: skipping comment post. Rendered preview:${r}`);
    console.log('---8<---');
    console.log(renderCommentBody(result, reviewMarkdown));
    console.log('---8<---');
  } else {
    console.error(`${d}[edward] Posting review comment...${r}`);
    const url = await postReviewComment(result, reviewMarkdown);
    if (url) {
      console.log(`${c.green}✓ Posted:${r} ${url}`);
    } else {
      console.log(`${c.yellow}⚠ Comment post failed — see stderr for details.${r}`);
      process.exit(1);
    }
  }
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
  ${b}review${r} <pr-url-or-number> [--repo owner/repo] [--dry-run] [--json]
                                   Review a GitHub PR against the repo's cached business invariants
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
  --auth MODE                      LLM auth mode for 'serve': claude-oauth | claude-api | codex (skips interactive menu)
  --no-fallback                    Disable auto-fallback to the other provider on retriable error (for discover)
  --branch NAME, -b NAME           Scan a specific branch instead of the repo default (for discover / ci-audit)
  --context-file PATH              Absolute path to a business context .yml/.json; skips the interactive resolve step
  --refresh-context                Ignore cached context and regenerate via LLM auto-extract
  --skip-functional-ci             Run discover without the functional CI gap analysis phase
  --no-interactive                 Don't prompt for context confirmation (auto-accept / auto-skip)
  --dry-run                        For 'review': print result but don't post comment to the PR
  --repo owner/name                For 'review': pair with a bare PR number
  --reason "..."                   Reason for dismiss
  --until ISO                      ISO timestamp for snooze

${b}EXAMPLES${r}
  edward serve                      # default: claude provider
  edward serve --provider codex     # use codex (GPT) instead of claude
  edward doctor                     # check both provider availability
  edward repos add teamo-lab/clawschool
  edward discover teamo-lab/clawschool --wait
  edward discover teamo-lab/clawschool --wait --provider codex
  edward discover floatmiracle/ama-user-service --branch shufanci --wait
  edward discover my/repo --context-file ~/ctx.yml --wait
  edward discover my/repo --refresh-context --wait   # force regenerate business context
  edward review https://github.com/floatmiracle/ama-user-service/pull/10 --dry-run
  edward review 10 --repo floatmiracle/ama-user-service --dry-run --json
  edward suggestions teamo-lab/clawschool
  edward approve a1b2c3d4
  edward dismiss a1b2c3d4 --reason "won't fix"
  edward tasks teamo-lab/clawschool --json | jq '.[] | select(.risk_level=="high")'

${b}ENVIRONMENT${r}
  EDWARD_URL         Server URL for CLI commands (default: http://localhost:8080)
  EDWARD_PORT        Port for 'edward serve' (default: 8080)
  EDWARD_PROVIDER    Default LLM provider (claude|codex). Overridden by --provider flag.
  EDWARD_NO_FALLBACK If set to 1, disables auto-fallback to the other provider on retriable errors.
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

      case 'review':
        await cmdReview(args);
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
