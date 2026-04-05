/**
 * Agent-driven codebase analysis using local Claude Code CLI.
 *
 * Spawns `claude -p` against a cloned repo to perform deep analysis:
 *   - Code quality issues (dead code, complexity, naming)
 *   - Security concerns (hardcoded secrets, injection risks)
 *   - Test coverage gaps (untested modules, missing edge cases)
 *   - Dependency issues (outdated, vulnerable, unused)
 *   - TODO/FIXME/HACK comment audit
 *   - Error handling gaps
 *   - Type safety improvements
 *   - Config drift / env var issues
 *   - Performance anti-patterns
 *
 * Returns structured JSON that integrates with the existing task pipeline.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { TaskType, RiskLevel, TaskEvidence, TaskImpact, TaskVerification } from '../types/index.js';
const logger = pino({ name: 'agent-analyzer' });

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/zhangyiming/.local/bin/claude';

// ── Types ──

export interface AgentTask {
  type: TaskType;
  title: string;
  description: string;
  confidence: number;
  riskLevel: RiskLevel;
  evidence: TaskEvidence;
  impact: TaskImpact;
  verification: TaskVerification;
}

interface ClaudeResult {
  type: string;
  result: string;
  is_error: boolean;
  total_cost_usd: number;
  duration_ms: number;
}

// ── Prompt ──

const ANALYSIS_PROMPT = `You are Repo Steward, an expert engineering analyst. Your job is to analyze this codebase and find concrete, actionable maintenance tasks that a coding agent can safely execute as a pull request.

IMPORTANT RULES:
- Only suggest tasks you are HIGHLY confident about based on actual code you can see
- Each task must be specific enough that another AI agent can implement it without ambiguity
- Prefer small, isolated, low-risk changes over large refactors
- Focus on things that clearly improve code health, not style preferences

ANALYSIS DIMENSIONS (check all):
1. **Dead code / unused exports** — files, functions, variables that are never imported/called
2. **TODO/FIXME/HACK/XXX comments** — actionable ones that can be resolved
3. **Error handling gaps** — catch blocks that swallow errors, missing error boundaries, unhandled promise rejections
4. **Type safety** — \`any\` types that can be narrowed, missing null checks, unsafe casts
5. **Test gaps** — modules with zero test coverage, critical paths without tests
6. **Dependency issues** — outdated packages, known vulnerabilities, unused dependencies in package.json
7. **Security** — hardcoded secrets, SQL injection risks, XSS vectors, unsafe eval/exec
8. **Performance** — N+1 queries, missing indexes suggested by query patterns, unnecessary re-renders, blocking I/O in hot paths
9. **Config drift** — env vars referenced but not in .env.example, inconsistent config patterns
10. **Documentation gaps** — public APIs without docs, misleading comments, outdated README sections

OUTPUT FORMAT — respond with ONLY a JSON array (no markdown, no explanation):
[
  {
    "type": "code_quality|security_fix|perf_improvement|dead_code|test_gap|todo_cleanup|dependency_upgrade|error_handling|type_safety|config_drift|doc_gap|ci_fix|deploy_fix",
    "title": "Short actionable title (imperative mood, e.g. 'Remove unused helper functions in utils.ts')",
    "description": "2-3 sentence description of what to change and why",
    "confidence": 0.0-1.0,
    "riskLevel": "low|medium|high",
    "evidence": {
      "signals": ["One-line evidence statement per finding"],
      "codeSnippets": [{"file": "path/to/file.ts", "line": 42, "content": "the problematic code"}]
    },
    "impact": {
      "estimatedFiles": ["path/to/file1.ts", "path/to/file2.ts"],
      "estimatedLinesChanged": 25,
      "blastRadius": "isolated|module|cross_module"
    },
    "verification": {
      "method": "How to verify the fix",
      "steps": ["Step 1", "Step 2"],
      "successCriteria": ["Criterion 1", "Criterion 2"]
    }
  }
]

Find 5-15 tasks. Only include tasks with confidence >= 0.6. Be specific about file paths and line numbers.`;

// ── Clone + Analyze ──

export async function analyzeRepo(fullName: string): Promise<AgentTask[]> {
  const startTime = Date.now();
  logger.info({ fullName }, 'Starting agent analysis');

  const tmpDir = await mkdtemp(join(tmpdir(), 'steward-'));
  const repoDir = join(tmpDir, 'repo');

  try {
    // Shallow clone
    logger.info({ fullName, tmpDir }, 'Cloning repo');
    execFileSync('git', [
      'clone', '--depth', '1',
      `https://github.com/${fullName}.git`,
      repoDir,
    ], { timeout: 60_000 });

    logger.info({ fullName }, 'Running Claude analysis');
    const tasks = await runClaudeAnalysis(repoDir, fullName);

    const elapsed = Date.now() - startTime;
    logger.info({ fullName, taskCount: tasks.length, elapsed }, 'Agent analysis complete');
    return tasks;

  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runClaudeAnalysis(repoDir: string, fullName: string): Promise<AgentTask[]> {
  // Build clean env — MUST delete CLAUDECODE and CLAUDE_CODE_ENTRYPOINT
  // or the nested-session guard will block the child process
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p', ANALYSIS_PROMPT,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--model', 'sonnet',
      '--max-turns', '10',
      '--max-budget-usd', '2',
    ], {
      cwd: repoDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      logger.warn({ fullName }, 'Claude CLI approaching timeout, killing');
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, 600_000);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (!stdout || stdout.length === 0) {
        logger.error({ fullName, code, stderr: stderr.slice(0, 300) }, 'Claude produced no output');
        resolve([]);
        return;
      }

      try {
        const result: ClaudeResult = JSON.parse(stdout);

        if (result.is_error) {
          logger.error({ fullName, error: result.result }, 'Claude analysis returned error');
          resolve([]);
          return;
        }

        logger.info({
          fullName,
          cost: result.total_cost_usd,
          duration: result.duration_ms,
        }, 'Claude response received');

        resolve(parseAgentOutput(result.result));
      } catch (err: any) {
        logger.error({ fullName, err: err.message, stdoutLen: stdout.length }, 'Failed to parse Claude output');
        resolve([]);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.error({ fullName, err: err.message }, 'Claude spawn error');
      resolve([]);
    });
  });
}

function parseAgentOutput(text: string): AgentTask[] {
  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return validateTasks(parsed);
  } catch {}

  // Try extracting JSON from markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) return validateTasks(parsed);
    } catch {}
  }

  // Try finding array in the text
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return validateTasks(parsed);
    } catch {}
  }

  logger.warn('Failed to parse agent output as JSON');
  return [];
}

const VALID_TYPES = new Set([
  'ci_fix', 'deploy_fix', 'todo_cleanup', 'test_gap', 'dependency_upgrade',
  'code_quality', 'security_fix', 'perf_improvement', 'dead_code', 'config_drift',
  'doc_gap', 'error_handling', 'type_safety',
]);

const VALID_RISK = new Set(['low', 'medium', 'high']);

function validateTasks(raw: unknown[]): AgentTask[] {
  const tasks: AgentTask[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;

    // Required fields
    if (!t.title || !t.description || !t.type) continue;
    if (!VALID_TYPES.has(t.type as string)) continue;

    const confidence = typeof t.confidence === 'number' ? t.confidence : 0.6;
    if (confidence < 0.5) continue; // skip very low confidence

    const riskLevel = VALID_RISK.has(t.riskLevel as string)
      ? (t.riskLevel as RiskLevel) : 'low';

    const evidence = t.evidence as Record<string, unknown> | undefined;
    const impact = t.impact as Record<string, unknown> | undefined;
    const verification = t.verification as Record<string, unknown> | undefined;

    tasks.push({
      type: t.type as TaskType,
      title: String(t.title),
      description: String(t.description),
      confidence: Math.max(0, Math.min(1, confidence)),
      riskLevel,
      evidence: {
        signals: Array.isArray(evidence?.signals) ? evidence.signals.map(String) : [String(t.description)],
        codeSnippets: Array.isArray(evidence?.codeSnippets) ? evidence.codeSnippets as any : undefined,
        logSnippets: Array.isArray(evidence?.logSnippets) ? evidence.logSnippets.map(String) : undefined,
      },
      impact: {
        estimatedFiles: Array.isArray(impact?.estimatedFiles) ? impact.estimatedFiles.map(String) : [],
        estimatedLinesChanged: typeof impact?.estimatedLinesChanged === 'number' ? impact.estimatedLinesChanged : 20,
        blastRadius: (['isolated', 'module', 'cross_module', 'system_wide'].includes(impact?.blastRadius as string)
          ? impact!.blastRadius as any : 'isolated'),
      },
      verification: {
        method: String(verification?.method || 'Tests pass'),
        steps: Array.isArray(verification?.steps) ? verification.steps.map(String) : ['Run tests'],
        successCriteria: Array.isArray(verification?.successCriteria) ? verification.successCriteria.map(String) : ['All checks pass'],
        rollbackPlan: verification?.rollbackPlan ? String(verification.rollbackPlan) : undefined,
      },
    });
  }

  return tasks;
}
