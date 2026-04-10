/**
 * Code-level PR review via Qodo Merge (pr-agent).
 *
 * Edward handles business-invariant checking; Qodo Merge handles code-level
 * review (logic bugs, parse edge-cases, defensive patterns, security). They
 * are complementary and both post their own comment to the PR.
 *
 * This module is a thin subprocess wrapper. It never imports pr-agent source
 * directly — it shells out to the Python CLI, consistent with how Edward
 * shells out to the `claude` CLI binary.
 *
 * Required: pr-agent installed in one of the searched venv locations.
 * Install once: python3.12 -m venv ~/.edward/pr-agent-venv &&
 *               ~/.edward/pr-agent-venv/bin/pip install pr-agent
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// ── Venv discovery ──

const VENV_SEARCH_PATHS = [
  `${homedir()}/.edward/pr-agent-venv`,
  `/tmp/pr-agent-venv`,
];

function findPrAgentPython(): string | null {
  for (const venv of VENV_SEARCH_PATHS) {
    const py = `${venv}/bin/python3.12`;
    if (existsSync(py)) return py;
    const py3 = `${venv}/bin/python3`;
    if (existsSync(py3)) return py3;
  }
  return null;
}

function resolveGithubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// ── Public API ──

export interface CodeReviewResult {
  ok: boolean;
  /** true if pr-agent binary / venv not found — soft skip, not an error */
  skipped: boolean;
  skip_reason?: string;
  /** stdout + stderr from pr-agent (for debug logging) */
  log?: string;
}

/**
 * Run Qodo Merge (pr-agent) on a GitHub PR and post its comment directly.
 * Returns immediately after the subprocess exits — pr-agent manages its own
 * GitHub comment (persistent mode: create-or-update).
 */
export async function runCodeReview(prUrl: string): Promise<CodeReviewResult> {
  const python = findPrAgentPython();
  if (!python) {
    return {
      ok: false,
      skipped: true,
      skip_reason:
        'pr-agent not installed. Run: python3.12 -m venv ~/.edward/pr-agent-venv && ' +
        '~/.edward/pr-agent-venv/bin/pip install pr-agent',
    };
  }

  const githubToken = resolveGithubToken();
  if (!githubToken) {
    return {
      ok: false,
      skipped: true,
      skip_reason: 'no GitHub token available for pr-agent (set GITHUB_TOKEN or log in with gh)',
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // pr-agent uses dynaconf double-underscore separator
    GITHUB__USER_TOKEN: githubToken,
    CONFIG__MODEL: 'anthropic/claude-haiku-4-5-20251001',
    CONFIG__FALLBACK_MODELS: '[]',
    CONFIG__CUSTOM_MODEL_MAX_TOKENS: '200000',
    // Strip proxy env so requests go directly to GitHub / Anthropic
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    all_proxy: '',
  };
  if (anthropicKey) {
    env.ANTHROPIC__KEY = anthropicKey;
  }

  const result = spawnSync(
    python,
    ['-m', 'pr_agent.cli', '--pr_url', prUrl, 'review'],
    {
      encoding: 'utf-8',
      env,
      timeout: 5 * 60 * 1000, // 5 minutes
      maxBuffer: 4 * 1024 * 1024,
    }
  );

  const log = [result.stdout, result.stderr].filter(Boolean).join('\n');

  if (result.status === 0 || log.includes('Review output')) {
    return { ok: true, skipped: false, log };
  }

  return {
    ok: false,
    skipped: false,
    skip_reason: `pr-agent exited ${result.status}`,
    log,
  };
}

/** True if the pr-agent venv is present and usable. */
export function isCodeReviewAvailable(): boolean {
  return findPrAgentPython() !== null;
}
