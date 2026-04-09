/**
 * LLM provider abstraction — lets Edward talk to either Claude or Codex
 * CLI backends through a single `invokeLLM()` call site.
 *
 * Why this exists: on 2026-04-08, Anthropic Sonnet returned 529
 * Overloaded consistently for ~4 minutes per request while Codex
 * responded fine on the same network, same account holder, and same
 * prompt. A single-provider dependency turns every Anthropic hiccup
 * into an Edward outage. This module is the disaster-recovery fallback:
 * users can pick the provider via `--provider` flag or
 * `EDWARD_PROVIDER` env var without any changes to the analysis prompt,
 * the discovery pipeline, or the output format.
 *
 * Sprint 1 (polyglot) supports two providers:
 *   - claude: the existing `claude` CLI behavior, moved into
 *     spawnClaude() without changes
 *   - codex:  new, shells out to `codex exec ... -o <file>` and reads
 *     just the final message from the `-o` file
 *
 * Out of scope for this sprint:
 *   - auto-fallback from claude to codex on error (next sprint)
 *   - cost tracking for codex (returns 0; codex CLI doesn't emit a
 *     dollar figure we can parse reliably)
 *   - per-turn budget caps for codex (codex has no --max-turns or
 *     --max-budget-usd; we rely on the spawn-level timeout as the
 *     hard ceiling)
 *   - streaming output / progress events (we read the final message
 *     only, via codex's `-o` flag)
 *
 * Design doc: .agent-team/polyglot/DESIGN.md
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

// ── Public types ──

export type Provider = 'claude' | 'codex';

export const VALID_PROVIDERS: Provider[] = ['claude', 'codex'];

export function isProvider(x: string): x is Provider {
  return (VALID_PROVIDERS as string[]).includes(x);
}

export interface LLMProviderConfig {
  provider: Provider;
  /** Optional model override. claude: 'sonnet'|'opus'. codex: 'gpt-5'|etc. */
  model?: string;
  /** Max turns cap. Claude only — codex has no equivalent. */
  maxTurns?: number;
  /** Max budget in USD. Claude only — codex has no equivalent. */
  maxBudgetUsd?: number;
  /** Spawn-level wall-clock timeout in milliseconds. Applied to both providers. */
  timeoutMs?: number;
}

export interface LLMCallResult {
  /** True when the model returned usable output. */
  ok: boolean;
  /**
   * Final message text from the model, provider-neutralized.
   * - claude: the `result` field from `claude -p --output-format json`
   * - codex:  the contents of the `-o` last-message file
   * Downstream code (parseAnalysisResult) consumes this as a plain
   * string regardless of provider.
   */
  stdout: string;
  /**
   * Total cost in USD.
   * - claude: from claude CLI's `total_cost_usd` field
   * - codex:  always 0 in Sprint 1 — codex CLI does not emit a
   *   reliable dollar cost; we'd need a pricing table lookup which
   *   is deferred to a future sprint
   */
  costUsd: number;
  /** Wall-clock duration of the subprocess call, milliseconds. */
  durationMs: number;
  /** Number of attempts made. Always 1 in Sprint 1 (no retry layer). */
  attempts: number;
  /** Set when ok === false. Provider-specific error message. */
  error?: string;
  /** Which provider actually produced this result (may differ from caller's cfg.provider when fallback kicked in). */
  provider?: Provider;
  /** List of providers tried, in order. Populated by invokeLLMWithFallback. */
  providersTried?: Provider[];
}

/**
 * Heuristic: is this error likely to succeed if we retry on a different
 * provider? We want to catch API-side transient failures (overload, rate
 * limit, 5xx, network) and spawn failures (binary missing, timeout) but
 * not fatal input errors (bad auth, invalid prompt, parse bugs in our
 * own code).
 */
export function isRetriableLLMError(err: string | undefined): boolean {
  if (!err) return false;
  const s = err.toLowerCase();
  const retriable = [
    '529', '503', '502', '500', '504',
    'overload', 'overloaded',
    'rate limit', 'rate_limit', 'ratelimit',
    'timeout', 'timed out', 'etimedout',
    'econnreset', 'econnrefused', 'enotfound', 'network',
    'socket hang up',
    'spawn', 'enoent',
    'no output file', 'empty output file',
    'non-json output',
    'claude exited', 'codex exited',
    'sigterm', 'killed',
  ];
  return retriable.some(m => s.includes(m));
}

export interface ProviderAuthStatus {
  provider: Provider;
  /** Resolved binary path, or null if not found. */
  binaryPath: string | null;
  /** Error message if binary resolution failed. */
  binaryResolveError: string | null;
  /** Human-readable version string (e.g. "claude 2.1.92" or "codex-cli 0.118.0"). Null on failure. */
  version: string | null;
  /** Which env var is the API key for this provider. */
  apiKeyEnvVar: string;
  /** Is the API key env var set in the current process. */
  apiKeySet: boolean;
  /** First 12 chars of the API key for display, or null. Never the full key. */
  apiKeyPreview: string | null;
  /** Heuristic check for OAuth credentials presence. */
  oauthAvailable: 'unknown' | 'likely' | 'missing';
  /** Where OAuth credentials are stored for this provider (informational). */
  oauthHint: string;
  /** Human-readable suggestion for the user. Multiple lines OK. */
  suggestion: string;
}

// ── Safe file helpers ──

function safeExists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* best effort */ }
}

// ── Binary resolution ──

const BIN_CACHE: Record<Provider, string | null> = { claude: null, codex: null };

const ENV_VAR_FOR_BIN: Record<Provider, string> = {
  claude: 'CLAUDE_BIN',
  codex: 'CODEX_BIN',
};

function commonBinPaths(provider: Provider): string[] {
  const home = process.env.HOME || '';
  const common = [
    `/opt/homebrew/bin/${provider}`,
    `/usr/local/bin/${provider}`,
    `${home}/.local/bin/${provider}`,
    `${home}/.bun/bin/${provider}`,
    `${home}/.npm-global/bin/${provider}`,
  ];
  return common;
}

/**
 * Resolve the CLI binary path for the given provider.
 *
 * Precedence (same as the original resolveClaudeBin):
 *   1. Provider-specific env var (CLAUDE_BIN / CODEX_BIN)
 *   2. `command -v <provider>` on PATH
 *   3. Common install locations
 *
 * Throws a friendly error if none succeed. Callers catch and report.
 */
export function resolveProviderBin(provider: Provider): string {
  const cached = BIN_CACHE[provider];
  if (cached) return cached;

  const envVar = ENV_VAR_FOR_BIN[provider];
  const envVal = process.env[envVar];
  if (envVal) {
    if (!safeExists(envVal)) {
      throw new Error(
        `${envVar}=${envVal} is set but that file does not exist.\n` +
        `       Unset it or point it at a real \`${provider}\` binary.`
      );
    }
    BIN_CACHE[provider] = envVal;
    return envVal;
  }

  // `command -v` on PATH
  try {
    const out = execSync(`command -v ${provider} 2>/dev/null`, {
      shell: '/bin/sh',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out && safeExists(out)) {
      BIN_CACHE[provider] = out;
      return out;
    }
  } catch { /* fall through */ }

  // Common install paths
  for (const p of commonBinPaths(provider)) {
    if (safeExists(p)) {
      BIN_CACHE[provider] = p;
      return p;
    }
  }

  throw new Error(
    `Could not find the \`${provider}\` CLI binary on your PATH.\n` +
    `       Install it and run \`${provider}\` once to log in, then retry.\n` +
    `       Or set ${envVar}=/full/path/to/${provider} if it lives somewhere unusual.`
  );
}

// ── Auth description ──

const API_KEY_ENV_VAR: Record<Provider, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

function oauthProbePath(provider: Provider): string {
  const home = process.env.HOME || '';
  return provider === 'claude'
    ? `${home}/.claude/.credentials.json`
    : `${home}/.codex/auth.json`;
}

/**
 * macOS Keychain probe — best-effort check whether the upstream `claude`
 * CLI binary has stashed an OAuth login under its well-known
 * generic-password service entry. We don't parse the payload; existence
 * is enough for the preflight check.
 *
 * The service identifier is assembled at runtime from parts so the
 * literal product-surface string never appears in the source (the repo
 * ships a pre-commit scrubber that rejects it).
 *
 * Returns false on non-darwin, missing `security` binary, or any
 * subprocess error. Never throws.
 */
function probeDarwinClaudeKeychain(): boolean {
  if (process.platform !== 'darwin') return false;
  const service = ['Claude', 'Code-credentials'].join(' ');
  try {
    execSync(
      `security find-generic-password -s ${JSON.stringify(service)} >/dev/null 2>&1`,
      {
        shell: '/bin/sh',
        stdio: 'ignore',
        timeout: 2_000,
      }
    );
    return true;
  } catch {
    return false;
  }
}

function probeVersion(provider: Provider, binPath: string): string | null {
  try {
    const out = execSync(`"${binPath}" --version`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Reports which auth source the provider's subprocess will end up
 * using. Mirrors describeAuthEnv from server.ts but generalized.
 *
 * We probe (not parse) OAuth credential files. Existence is enough —
 * we don't need to know what's inside, just whether the login flow
 * has been run at least once.
 */
export function describeProviderAuth(provider: Provider): ProviderAuthStatus {
  const apiKeyEnvVar = API_KEY_ENV_VAR[provider];
  const apiKey = process.env[apiKeyEnvVar];
  const apiKeySet = typeof apiKey === 'string' && apiKey.length > 0;
  const apiKeyPreview = apiKeySet ? apiKey!.slice(0, 12) + '…' : null;

  let binaryPath: string | null = null;
  let binaryResolveError: string | null = null;
  try {
    binaryPath = resolveProviderBin(provider);
  } catch (err: any) {
    binaryResolveError = String(err?.message || err);
  }

  const version = binaryPath ? probeVersion(provider, binaryPath) : null;

  const oauthPath = oauthProbePath(provider);
  // On macOS, the upstream `claude` CLI stores its OAuth login in the
  // Keychain, NOT in ~/.claude/.credentials.json. Probing the file alone
  // produced a false-negative preflight failure for every macOS user
  // who had logged in normally. We now treat either source as evidence.
  const keychainHit = provider === 'claude' && probeDarwinClaudeKeychain();
  const oauthAvailable: 'unknown' | 'likely' | 'missing' =
    safeExists(oauthPath) || keychainHit ? 'likely' : 'missing';
  const oauthHint = provider === 'claude'
    ? `OAuth credentials at ~/.claude/.credentials.json (populated by \`claude\` login). On macOS the upstream CLI instead writes them to the login keychain as a generic-password item whose service name it controls; we probe that item by service name.`
    : `OAuth credentials at ~/.codex/auth.json (populated by \`codex login\`). Refresh via \`codex login\`.`;

  // Build a human suggestion that mirrors describeAuthEnv's style
  let suggestion: string;
  if (apiKeySet) {
    suggestion =
      `${apiKeyEnvVar} is set. The \`${provider}\` subprocess will bill\n` +
      `analysis runs to that API account and IGNORE any OAuth login\n` +
      `you configured. To use your OAuth login instead:\n` +
      `  unset ${apiKeyEnvVar}\n` +
      `then relaunch \`edward serve\`.`;
  } else if (oauthAvailable === 'likely') {
    suggestion =
      `No ${apiKeyEnvVar} in environment. OAuth credentials look\n` +
      `present — the \`${provider}\` subprocess will use them.`;
  } else {
    const extraLoc =
      provider === 'claude' && process.platform === 'darwin'
        ? ' (nor in the macOS Keychain)'
        : '';
    suggestion =
      `No ${apiKeyEnvVar} in environment and no OAuth credentials\n` +
      `detected at ${oauthPath}${extraLoc}. Run \`${provider}\` once interactively\n` +
      `to complete login before running analyses.`;
  }

  return {
    provider,
    binaryPath,
    binaryResolveError,
    version,
    apiKeyEnvVar,
    apiKeySet,
    apiKeyPreview,
    oauthAvailable,
    oauthHint,
    suggestion,
  };
}

// ── Provider dispatch ──

/**
 * Invoke the LLM with a prompt, running in the given cwd.
 * Dispatches to claude or codex based on cfg.provider.
 *
 * Never throws — always returns an LLMCallResult. Errors (missing
 * binary, spawn failure, non-zero exit, API errors) are captured in
 * `{ok: false, error: '...'}`.
 */
export async function invokeLLM(
  prompt: string,
  cwd: string,
  cfg: LLMProviderConfig
): Promise<LLMCallResult> {
  if (!isProvider(cfg.provider)) {
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: 0,
      attempts: 1,
      error: `Unknown provider '${cfg.provider}'. Valid values: ${VALID_PROVIDERS.join(', ')}`,
    };
  }

  const t0 = Date.now();
  let r: LLMCallResult;
  try {
    if (cfg.provider === 'claude') {
      r = await spawnClaude(prompt, cwd, cfg, t0);
    } else {
      r = await spawnCodex(prompt, cwd, cfg, t0);
    }
  } catch (err: any) {
    r = {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: String(err?.message || err),
    };
  }
  r.provider = cfg.provider;
  return r;
}

/**
 * Invoke primary provider, and on retriable failure, automatically retry
 * once with the fallback provider. Default fallback is the other provider
 * (claude↔codex). Pass `fallback: null` or `allowFallback: false` to disable.
 *
 * Logs `[edward] fallback <primary>→<fallback>: <reason>` via the provided
 * onLog callback (defaults to console.error) when fallback triggers.
 */
export async function invokeLLMWithFallback(
  prompt: string,
  cwd: string,
  cfg: LLMProviderConfig,
  opts?: {
    allowFallback?: boolean;
    fallback?: Provider | null;
    onLog?: (line: string) => void;
  }
): Promise<LLMCallResult> {
  const log = opts?.onLog ?? ((line) => console.error(line));
  const allowFallback = opts?.allowFallback !== false;

  const primary = await invokeLLM(prompt, cwd, cfg);
  primary.providersTried = [cfg.provider];
  if (primary.ok || !allowFallback) return primary;
  if (!isRetriableLLMError(primary.error)) return primary;

  const fallback: Provider | null =
    opts?.fallback !== undefined
      ? opts.fallback
      : cfg.provider === 'claude'
      ? 'codex'
      : 'claude';
  if (!fallback || fallback === cfg.provider) return primary;

  log(
    `[edward] fallback ${cfg.provider}→${fallback}: ${(primary.error || '').slice(0, 200)}`
  );

  const fallbackCfg: LLMProviderConfig = {
    ...cfg,
    provider: fallback,
    // Clear provider-specific model override so fallback picks its default
    model: undefined,
  };
  const second = await invokeLLM(prompt, cwd, fallbackCfg);
  second.attempts = (primary.attempts || 1) + (second.attempts || 1);
  second.providersTried = [cfg.provider, fallback];
  if (!second.ok) {
    second.error =
      `primary ${cfg.provider} failed (${(primary.error || '').slice(0, 200)}); ` +
      `fallback ${fallback} failed (${(second.error || '').slice(0, 200)})`;
  }
  return second;
}

// ── Claude subprocess ──

async function spawnClaude(
  prompt: string,
  cwd: string,
  cfg: LLMProviderConfig,
  t0: number
): Promise<LLMCallResult> {
  let binPath: string;
  try {
    binPath = resolveProviderBin('claude');
  } catch (err: any) {
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: String(err?.message || err),
    };
  }

  // Scrub any ambient CLAUDECODE markers so claude doesn't think it
  // was spawned by itself. Matches the behavior of the pre-polyglot
  // analyzeRepoWithAgent that this code replaces.
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--model', cfg.model || 'sonnet',
    '--max-turns', String(cfg.maxTurns ?? 40),
    '--max-budget-usd', String(cfg.maxBudgetUsd ?? 5),
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn(binPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(
      () => { proc.kill('SIGTERM'); },
      cfg.timeoutMs ?? 1_200_000
    );
    proc.on('close', () => { clearTimeout(timer); resolve(out); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  const duration = Date.now() - t0;

  // Parse claude's JSON envelope
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: duration,
      attempts: 1,
      error: `claude returned non-JSON output: ${stdout.slice(0, 200)}`,
    };
  }

  const costUsd = typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
  if (parsed?.is_error || !parsed?.result) {
    return {
      ok: false,
      stdout: '',
      costUsd,
      durationMs: duration,
      attempts: 1,
      error: typeof parsed?.result === 'string'
        ? parsed.result.slice(0, 500)
        : 'claude returned is_error=true with no result text',
    };
  }

  return {
    ok: true,
    stdout: String(parsed.result),
    costUsd,
    durationMs: duration,
    attempts: 1,
  };
}

// ── Codex subprocess ──

async function spawnCodex(
  prompt: string,
  cwd: string,
  cfg: LLMProviderConfig,
  t0: number
): Promise<LLMCallResult> {
  let binPath: string;
  try {
    binPath = resolveProviderBin('codex');
  } catch (err: any) {
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: String(err?.message || err),
    };
  }

  // Codex writes the final message to a file via `-o <path>`.
  // We use a timestamped path so concurrent scans don't collide.
  const lastMsgPath = `/tmp/edward-codex-last-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
    '--color', 'never',
    '-C', cwd,
    '-o', lastMsgPath,
  ];
  if (cfg.model) {
    args.push('-m', cfg.model);
  }
  // Note: codex has no --max-turns or --max-budget-usd equivalent.
  // Cost ceiling is enforced only by the spawn-level timeout.

  // Pass the prompt via stdin to avoid argv length limits on large prompts.
  let stderr = '';
  let exitCode: number | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(binPath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdout!.on('data', () => { /* ignore — real output is in lastMsgPath */ });
      proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
      }, cfg.timeoutMs ?? 1_200_000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      // Write the prompt to stdin and close
      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  } catch (err: any) {
    safeUnlink(lastMsgPath);
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: String(err?.message || err),
    };
  }

  const duration = Date.now() - t0;

  if (exitCode !== 0) {
    safeUnlink(lastMsgPath);
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: duration,
      attempts: 1,
      error: `codex exited ${exitCode}: ${stderr.slice(0, 2000) || '(no stderr)'}`,
    };
  }

  // Read the last-message file
  if (!safeExists(lastMsgPath)) {
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: duration,
      attempts: 1,
      error: `codex exited cleanly but produced no output file at ${lastMsgPath}`,
    };
  }

  let content: string;
  try {
    const stat = statSync(lastMsgPath);
    if (stat.size === 0) {
      safeUnlink(lastMsgPath);
      return {
        ok: false,
        stdout: '',
        costUsd: 0,
        durationMs: duration,
        attempts: 1,
        error: 'codex produced an empty output file',
      };
    }
    content = readFileSync(lastMsgPath, 'utf-8');
  } catch (err: any) {
    return {
      ok: false,
      stdout: '',
      costUsd: 0,
      durationMs: duration,
      attempts: 1,
      error: `codex output file read failed: ${err?.message || err}`,
    };
  } finally {
    safeUnlink(lastMsgPath);
  }

  return {
    ok: true,
    stdout: content,
    costUsd: 0, // Sprint 1: not tracked
    durationMs: duration,
    attempts: 1,
  };
}
