import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';
import { config } from '../config/index.js';
import { query, transaction } from '../lib/db.js';
import { getUnprocessedSignals, markSignalProcessed } from './signal-collector.js';
import { analyzeRepo, type AgentTask } from './agent-analyzer.js';
import type {
  Task,
  TaskType,
  RiskLevel,
  Signal,
  TaskEvidence,
  TaskImpact,
  TaskVerification,
  RepoSettings,
} from '../types/index.js';

const logger = pino({ name: 'task-discovery' });

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── Rule-based task generation ──

interface RuleCandidate {
  type: TaskType;
  title: string;
  description: string;
  evidence: TaskEvidence;
  impact: TaskImpact;
  verification: TaskVerification;
  baseConfidence: number;
  riskLevel: RiskLevel;
  signalIds: string[];
}

function ciFailureRule(signal: Signal): RuleCandidate | null {
  if (signal.type !== 'ci_failure') return null;

  const data = signal.extractedData;
  return {
    type: 'ci_fix',
    title: `Fix CI: ${data.title}`,
    description: `CI check failed: ${data.description}`,
    evidence: {
      signals: [`CI failure detected: ${data.title}`],
      logSnippets: data.errorMessage ? [data.errorMessage] : undefined,
    },
    impact: {
      estimatedFiles: data.filePaths ?? [],
      estimatedLinesChanged: 20,
      blastRadius: 'isolated',
    },
    verification: {
      method: 'CI passes on the fix branch',
      steps: ['Push fix to branch', 'Wait for CI to run', 'Verify all checks pass'],
      successCriteria: ['All CI checks green', 'No new failures introduced'],
    },
    baseConfidence: 0.7,
    riskLevel: 'low',
    signalIds: [signal.id],
  };
}

function deployFailureRule(signal: Signal): RuleCandidate | null {
  if (signal.type !== 'deploy_failure') return null;

  const data = signal.extractedData;
  return {
    type: 'deploy_fix',
    title: `Fix deploy: ${data.title}`,
    description: `Deployment failed: ${data.description}`,
    evidence: {
      signals: [`Deploy failure: ${data.title}`],
      logSnippets: data.errorMessage ? [data.errorMessage] : undefined,
    },
    impact: {
      estimatedFiles: data.filePaths ?? [],
      estimatedLinesChanged: 15,
      blastRadius: 'module',
    },
    verification: {
      method: 'Deploy succeeds after fix',
      steps: ['Push fix to branch', 'Trigger deploy', 'Verify deployment succeeds'],
      successCriteria: ['Deployment completes successfully', 'App is healthy post-deploy'],
      rollbackPlan: 'Revert the PR if deploy still fails',
    },
    baseConfidence: 0.65,
    riskLevel: 'medium',
    signalIds: [signal.id],
  };
}

function todoCleanupRule(signal: Signal): RuleCandidate | null {
  if (signal.type !== 'todo_comment') return null;

  const data = signal.extractedData;
  return {
    type: 'todo_cleanup',
    title: `Clean up: ${data.title}`,
    description: `Address TODO/FIXME comment: ${data.description}`,
    evidence: {
      signals: [`TODO found: ${data.title}`],
      codeSnippets: data.filePaths?.map((f) => ({ file: f, line: 0, content: data.description })),
    },
    impact: {
      estimatedFiles: data.filePaths ?? [],
      estimatedLinesChanged: 30,
      blastRadius: 'isolated',
    },
    verification: {
      method: 'TODO is resolved and tests pass',
      steps: ['Implement the TODO', 'Remove the TODO comment', 'Run tests'],
      successCriteria: ['TODO comment removed', 'Implementation complete', 'Tests pass'],
    },
    baseConfidence: 0.5,
    riskLevel: 'low',
    signalIds: [signal.id],
  };
}

function testGapRule(signal: Signal): RuleCandidate | null {
  if (signal.type !== 'test_coverage_gap') return null;

  const data = signal.extractedData;
  return {
    type: 'test_gap',
    title: `Add tests: ${data.title}`,
    description: `Coverage gap found: ${data.description}`,
    evidence: {
      signals: [`Coverage gap: ${data.title}`],
    },
    impact: {
      estimatedFiles: data.filePaths ?? [],
      estimatedLinesChanged: 60,
      blastRadius: 'isolated',
    },
    verification: {
      method: 'Coverage increases and tests pass',
      steps: ['Write tests for uncovered code', 'Run test suite', 'Check coverage report'],
      successCriteria: ['New tests pass', 'Coverage improves for target files'],
    },
    baseConfidence: 0.55,
    riskLevel: 'low',
    signalIds: [signal.id],
  };
}

const RULES = [ciFailureRule, deployFailureRule, todoCleanupRule, testGapRule];

// ── LLM-based confidence refinement ──

interface LLMRankingResult {
  confidence: number;
  riskLevel: RiskLevel;
  reasoning: string;
  refinedTitle?: string;
  refinedDescription?: string;
}

async function rankWithLLM(candidate: RuleCandidate): Promise<LLMRankingResult> {
  const prompt = `You are a senior engineering assistant. Evaluate this proposed maintenance task for a code repository.

Task:
- Type: ${candidate.type}
- Title: ${candidate.title}
- Description: ${candidate.description}
- Evidence: ${JSON.stringify(candidate.evidence.signals)}
- Estimated impact: ${candidate.impact.estimatedFiles.length} files, ~${candidate.impact.estimatedLinesChanged} lines
- Blast radius: ${candidate.impact.blastRadius}

Rate this task on these dimensions (respond in JSON):
1. confidence (0-1): How confident are you this task is real, actionable, and safe to execute?
2. riskLevel ("low" | "medium" | "high"): What's the risk of the fix introducing regressions?
3. reasoning: One sentence explaining your confidence rating.
4. refinedTitle: (optional) A better title if the original is unclear.
5. refinedDescription: (optional) A better description if needed.

Respond with ONLY valid JSON, no markdown.`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text) as LLMRankingResult;

    return {
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      riskLevel: ['low', 'medium', 'high'].includes(parsed.riskLevel)
        ? parsed.riskLevel
        : candidate.riskLevel,
      reasoning: parsed.reasoning ?? '',
      refinedTitle: parsed.refinedTitle,
      refinedDescription: parsed.refinedDescription,
    };
  } catch (err) {
    logger.warn({ err, taskTitle: candidate.title }, 'LLM ranking failed, using base confidence');
    return {
      confidence: candidate.baseConfidence,
      riskLevel: candidate.riskLevel,
      reasoning: 'LLM ranking unavailable, using rule-based confidence',
    };
  }
}

// ── Deduplication ──

async function isDuplicate(repoId: string, candidate: RuleCandidate): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tasks
     WHERE repo_id = $1
       AND type = $2
       AND title = $3
       AND status NOT IN ('dismissed', 'merged', 'failed')
       AND created_at > NOW() - INTERVAL '7 days'`,
    [repoId, candidate.type, candidate.title],
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

// ── Main discovery pipeline ──

export async function discoverTasks(repoId: string): Promise<Task[]> {
  logger.info({ repoId }, 'Starting task discovery');

  // Get repo info
  const repoResult = await query<{ settings: RepoSettings; full_name: string }>(
    'SELECT settings, full_name FROM repos WHERE id = $1',
    [repoId],
  );
  if (repoResult.rows.length === 0) {
    logger.warn({ repoId }, 'Repo not found');
    return [];
  }

  const { full_name: fullName } = repoResult.rows[0] as any;
  const settings = (repoResult.rows[0] as any).settings ?? {
    maxDailySuggestions: config.steward.maxDailySuggestions,
    enabledTaskTypes: [
      'ci_fix', 'deploy_fix', 'todo_cleanup', 'test_gap', 'dependency_upgrade',
      'code_quality', 'security_fix', 'perf_improvement', 'dead_code',
      'error_handling', 'type_safety', 'config_drift', 'doc_gap',
    ],
    notificationChannels: ['github'],
    confidenceThreshold: config.steward.defaultConfidenceThreshold,
  };

  const tasks: Task[] = [];

  // ── Phase 1: Signal-based rule engine (existing webhooks/signals) ──
  const signals = await getUnprocessedSignals(repoId);
  if (signals.length > 0) {
    const candidates: RuleCandidate[] = [];
    for (const signal of signals) {
      for (const rule of RULES) {
        const candidate = rule(signal);
        if (candidate && settings.enabledTaskTypes.includes(candidate.type)) {
          candidates.push(candidate);
        }
      }
    }

    logger.info({ repoId, candidateCount: candidates.length }, 'Rule-based candidates generated');

    for (const candidate of candidates) {
      if (await isDuplicate(repoId, candidate)) continue;
      const ranking = await rankWithLLM(candidate);
      if (ranking.confidence < settings.confidenceThreshold) continue;
      const task = await saveTask(repoId, candidate, ranking);
      tasks.push(task);
      if (tasks.length >= settings.maxDailySuggestions) break;
    }

    for (const signal of signals) {
      await markSignalProcessed(signal.id);
    }
  }

  // ── Phase 2: Agent-driven deep codebase analysis ──
  if (fullName && tasks.length < settings.maxDailySuggestions) {
    logger.info({ repoId, fullName }, 'Starting agent-driven codebase analysis');
    try {
      const agentTasks = await analyzeRepo(fullName);
      logger.info({ repoId, agentTaskCount: agentTasks.length }, 'Agent analysis returned tasks');

      for (const at of agentTasks) {
        if (tasks.length >= settings.maxDailySuggestions) break;

        // Dedup against existing tasks (agent tasks use title-based dedup)
        const dup = await isDuplicateByTitle(repoId, at.type, at.title);
        if (dup) {
          logger.debug({ title: at.title }, 'Skipping duplicate agent task');
          continue;
        }

        if (at.confidence < settings.confidenceThreshold) continue;

        // Save directly — agent already did the confidence assessment
        const task = await saveAgentTask(repoId, at);
        tasks.push(task);
      }
    } catch (err) {
      logger.error({ err, repoId }, 'Agent analysis failed — continuing with rule-based results only');
    }
  }

  logger.info({ repoId, taskCount: tasks.length }, 'Task discovery complete');
  return tasks;
}

async function isDuplicateByTitle(repoId: string, type: string, title: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tasks
     WHERE repo_id = $1
       AND type = $2
       AND title = $3
       AND status NOT IN ('dismissed', 'merged', 'failed')
       AND created_at > NOW() - INTERVAL '7 days'`,
    [repoId, type, title],
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

async function saveAgentTask(repoId: string, at: AgentTask): Promise<Task> {
  const result = await query(
    `INSERT INTO tasks (
       repo_id, signal_ids, type, status, title, description,
       evidence, impact, verification, confidence, risk_level, suggested_at
     ) VALUES ($1, '{}', $2, 'suggested', $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING *`,
    [
      repoId,
      at.type,
      at.title,
      at.description,
      JSON.stringify(at.evidence),
      JSON.stringify(at.impact),
      JSON.stringify(at.verification),
      at.confidence,
      at.riskLevel,
    ],
  );
  return result.rows[0] as unknown as Task;
}

async function saveTask(
  repoId: string,
  candidate: RuleCandidate,
  ranking: LLMRankingResult,
): Promise<Task> {
  const result = await query(
    `INSERT INTO tasks (
       repo_id, signal_ids, type, status, title, description,
       evidence, impact, verification, confidence, risk_level, suggested_at
     ) VALUES ($1, $2, $3, 'suggested', $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [
      repoId,
      candidate.signalIds,
      candidate.type,
      ranking.refinedTitle ?? candidate.title,
      ranking.refinedDescription ?? candidate.description,
      JSON.stringify(candidate.evidence),
      JSON.stringify(candidate.impact),
      JSON.stringify(candidate.verification),
      ranking.confidence,
      ranking.riskLevel,
    ],
  );

  return result.rows[0] as unknown as Task;
}

// ── Get suggestions for a repo ──

export async function getSuggestions(repoId: string): Promise<Task[]> {
  const result = await query(
    `SELECT * FROM tasks
     WHERE repo_id = $1
       AND status = 'suggested'
       AND (snooze_until IS NULL OR snooze_until < NOW())
     ORDER BY confidence DESC, created_at ASC
     LIMIT 10`,
    [repoId],
  );
  return result.rows as unknown as Task[];
}

export async function getTodaySuggestionCount(repoId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tasks
     WHERE repo_id = $1
       AND suggested_at >= CURRENT_DATE
       AND status IN ('suggested', 'approved', 'executing', 'pr_created', 'verified', 'merged')`,
    [repoId],
  );
  return parseInt(result.rows[0].count, 10);
}
