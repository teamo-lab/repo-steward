/**
 * Code-level PR review via Qodo Merge (pr-agent).
 *
 * Edward handles business-invariant checking; Qodo Merge handles code-level
 * review (logic bugs, parse edge-cases, defensive patterns, security). They
 * are complementary and their output is merged into a single PR comment.
 *
 * This module calls pr-agent as a Python library (not the CLI) via a thin
 * runner script written to ~/.edward/pr-agent-runner.py. The runner sets
 * publish_output=False so pr-agent never touches GitHub directly — it only
 * generates the review markdown and prints it to stdout. Edward then includes
 * that markdown in its own combined comment.
 *
 * Required: pr-agent installed in one of the searched venv locations.
 * Install once: python3.12 -m venv ~/.edward/pr-agent-venv &&
 *               ~/.edward/pr-agent-venv/bin/pip install pr-agent==0.2.7
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Runner script ──
// Written to ~/.edward/pr-agent-runner.py on first use.
// Calls pr-agent as a library with publish_output=False and prints the
// generated review markdown to stdout.

const PR_AGENT_RUNNER_SCRIPT = `\
import asyncio
import sys

from pr_agent.agent.pr_agent import PRAgent
from pr_agent.config_loader import get_settings


async def main(pr_url: str) -> None:
    # Suppress all GitHub API writes — we only want the generated markdown.
    get_settings().config.publish_output = False
    get_settings().config.publish_output_progress = False

    await PRAgent().handle_request(pr_url, "review")

    data = get_settings().data
    artifact = data.get("artifact") if isinstance(data, dict) else None
    if artifact:
        print(artifact, end="")
    else:
        sys.stderr.write("pr-agent: no artifact in settings.data\\n")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("usage: pr-agent-runner.py <pr_url>\\n")
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
`;

const RUNNER_PATH = join(homedir(), '.edward', 'pr-agent-runner.py');

function ensureRunnerScript(): void {
  // Always overwrite so the script stays in sync with this version of Edward.
  writeFileSync(RUNNER_PATH, PR_AGENT_RUNNER_SCRIPT, { encoding: 'utf-8', mode: 0o755 });
}

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
  /** true if pr-agent venv not found — soft skip, not an error */
  skipped: boolean;
  skip_reason?: string;
  /** stderr from the runner (for debug logging) */
  log?: string;
  /**
   * The review markdown printed by the runner script. Included verbatim
   * in Edward's combined PR comment — no separate GitHub comment is posted
   * by pr-agent.
   */
  reviewMarkdown?: string;
}

/**
 * Run Qodo Merge (pr-agent) on a GitHub PR and return the review markdown.
 * pr-agent runs in library mode with publish_output=False — it never posts
 * its own GitHub comment. The markdown is returned for Edward to include in
 * its single combined comment.
 */
export async function runCodeReview(prUrl: string): Promise<CodeReviewResult> {
  const python = findPrAgentPython();
  if (!python) {
    return {
      ok: false,
      skipped: true,
      skip_reason:
        'pr-agent not installed. Run: python3.12 -m venv ~/.edward/pr-agent-venv && ' +
        '~/.edward/pr-agent-venv/bin/pip install pr-agent==0.2.7',
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

  ensureRunnerScript();

  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GITHUB__USER_TOKEN: githubToken,
    CONFIG__MODEL: 'anthropic/claude-haiku-4-5-20251001',
    CONFIG__FALLBACK_MODELS: '[]',
    CONFIG__CUSTOM_MODEL_MAX_TOKENS: '200000',
    // Strip proxy env so requests go directly to Anthropic
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    all_proxy: '',
    ALL_PROXY: '',
  };
  if (anthropicKey) {
    env.ANTHROPIC__KEY = anthropicKey;
  }

  const result = spawnSync(
    python,
    [RUNNER_PATH, prUrl],
    {
      encoding: 'utf-8',
      env,
      timeout: 5 * 60 * 1000, // 5 minutes
      maxBuffer: 4 * 1024 * 1024,
    }
  );

  const log = result.stderr || '';
  const reviewMarkdown = (result.stdout || '').trim();

  if (result.status === 0 && reviewMarkdown) {
    return { ok: true, skipped: false, log, reviewMarkdown };
  }

  return {
    ok: false,
    skipped: false,
    skip_reason: `pr-agent runner exited ${result.status}`,
    log: [reviewMarkdown, log].filter(Boolean).join('\n'),
  };
}

/** True if the pr-agent venv is present and usable. */
export function isCodeReviewAvailable(): boolean {
  return findPrAgentPython() !== null;
}
