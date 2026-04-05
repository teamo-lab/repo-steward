import { Queue, Worker, Job } from 'bullmq';
import { pino } from 'pino';
import { config } from '../config/index.js';
import { redis } from '../lib/redis.js';
import { query, transaction } from '../lib/db.js';
import type { Task, Execution, ExecutionLog, Repo } from '../types/index.js';

const logger = pino({ name: 'task-executor' });

// ── BullMQ Queue ──

export const executionQueue = new Queue('task-execution', {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 },  // 7 days
    removeOnFail: { age: 30 * 24 * 60 * 60 },      // 30 days
  },
});

// ── Task action handlers ──

export async function approveTask(taskId: string): Promise<Execution> {
  const taskResult = await query<Task>('SELECT * FROM tasks WHERE id = $1', [taskId]);
  const task = taskResult.rows[0];

  if (!task) throw new Error(`Task not found: ${taskId}`);
  if ((task as any).status !== 'suggested') {
    throw new Error(`Task ${taskId} is not in suggested status (current: ${(task as any).status})`);
  }

  // Create execution record
  const branchName = `steward/${(task as any).type}/${taskId.slice(0, 8)}`;
  const execResult = await query<Execution>(
    `INSERT INTO executions (task_id, repo_id, status, branch_name)
     VALUES ($1, $2, 'queued', $3)
     RETURNING *`,
    [taskId, (task as any).repo_id, branchName],
  );
  const execution = execResult.rows[0];

  // Update task status
  await query(
    `UPDATE tasks SET status = 'approved', approved_at = NOW(), execution_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [(execution as any).id, taskId],
  );

  // Enqueue execution job
  await executionQueue.add('execute', {
    executionId: (execution as any).id,
    taskId,
    repoId: (task as any).repo_id,
  });

  logger.info({ taskId, executionId: (execution as any).id }, 'Task approved and queued');
  return execution as unknown as Execution;
}

export async function dismissTask(taskId: string, reason?: string): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'dismissed', dismiss_reason = $1, updated_at = NOW()
     WHERE id = $2`,
    [reason ?? null, taskId],
  );
  logger.info({ taskId, reason }, 'Task dismissed');
}

export async function snoozeTask(taskId: string, until: Date): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'snoozed', snooze_until = $1, updated_at = NOW()
     WHERE id = $2`,
    [until, taskId],
  );
  logger.info({ taskId, until }, 'Task snoozed');
}

// ── Execution worker ──

interface ExecuteJobData {
  executionId: string;
  taskId: string;
  repoId: string;
}

async function appendLog(executionId: string, level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  const log: ExecutionLog = {
    timestamp: new Date(),
    level,
    message,
  };
  await query(
    `UPDATE executions SET logs = logs || $1::jsonb WHERE id = $2`,
    [JSON.stringify([log]), executionId],
  );
}

async function executeTask(job: Job<ExecuteJobData>): Promise<void> {
  const { executionId, taskId, repoId } = job.data;
  logger.info({ executionId, taskId }, 'Starting task execution');

  try {
    // Update status to running
    await query(
      `UPDATE executions SET status = 'running', started_at = NOW() WHERE id = $1`,
      [executionId],
    );
    await query(
      `UPDATE tasks SET status = 'executing', updated_at = NOW() WHERE id = $1`,
      [taskId],
    );

    // Get task and repo details
    const taskResult = await query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    const task = taskResult.rows[0] as any;
    const repoResult = await query('SELECT * FROM repos WHERE id = $1', [repoId]);
    const repo = repoResult.rows[0] as any;

    if (!task || !repo) {
      throw new Error('Task or repo not found');
    }

    await appendLog(executionId, 'info', `Starting execution for: ${task.title}`);
    await appendLog(executionId, 'info', `Repository: ${repo.full_name}`);

    // Build the agent prompt based on task type and evidence
    const agentPrompt = buildAgentPrompt(task, repo);
    await appendLog(executionId, 'info', 'Agent prompt constructed');

    // Execute via Claude Code CLI (or mock in development)
    if (config.env === 'production') {
      await executeViaClaudeCode(executionId, agentPrompt, repo);
    } else {
      // Development: simulate execution
      await appendLog(executionId, 'info', '[DEV MODE] Simulating agent execution...');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await appendLog(executionId, 'info', '[DEV MODE] Agent execution simulated');
    }

    // Mark as PR created (in production, the agent would report this)
    await query(
      `UPDATE executions SET status = 'pr_created', completed_at = NOW() WHERE id = $1`,
      [executionId],
    );
    await query(
      `UPDATE tasks SET status = 'pr_created', updated_at = NOW() WHERE id = $1`,
      [taskId],
    );

    await appendLog(executionId, 'info', 'Execution completed successfully');
    logger.info({ executionId, taskId }, 'Task execution completed');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await appendLog(executionId, 'error', `Execution failed: ${errorMessage}`);

    await query(
      `UPDATE executions SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [executionId],
    );
    await query(
      `UPDATE tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [taskId],
    );

    logger.error({ err, executionId, taskId }, 'Task execution failed');
    throw err;
  }
}

function buildAgentPrompt(task: any, repo: any): string {
  const evidence = typeof task.evidence === 'string' ? JSON.parse(task.evidence) : task.evidence;
  const verification = typeof task.verification === 'string' ? JSON.parse(task.verification) : task.verification;

  return `You are a maintenance engineer working on the ${repo.full_name} repository.

## Task
${task.title}

## Description
${task.description}

## Evidence
${evidence.signals?.join('\n') ?? 'No additional evidence'}

${evidence.logSnippets?.length ? `## Log Snippets\n${evidence.logSnippets.join('\n---\n')}` : ''}

## Requirements
1. Create a branch and fix the issue described above
2. Keep changes minimal and focused
3. Do not change unrelated code
4. Add or update tests if applicable

## Verification
${verification.steps?.join('\n') ?? 'Run CI and verify it passes'}

## Success Criteria
${verification.successCriteria?.join('\n') ?? 'All checks pass'}

After making changes, create a pull request with a clear description of what was fixed and why.`;
}

async function executeViaClaudeCode(
  executionId: string,
  prompt: string,
  repo: any,
): Promise<void> {
  // In production, this would invoke claude-code CLI or API
  // For now, we structure the interface
  await appendLog(executionId, 'info', `Executing via Claude Code for ${repo.full_name}`);

  // The actual integration would be:
  // 1. Clone the repo to a temp directory
  // 2. Run `claude --prompt "${prompt}" --allowedTools Edit,Write,Bash`
  // 3. Parse the output to get the PR URL
  // 4. Update the execution record with PR details

  throw new Error('Production execution not yet implemented — use teamo run-agent for now');
}

// ── Worker lifecycle ──

let worker: Worker | null = null;

export function startExecutionWorker(): Worker {
  worker = new Worker<ExecuteJobData>('task-execution', executeTask, {
    connection: redis,
    concurrency: 2,
    limiter: {
      max: 5,
      duration: 60_000,  // max 5 jobs per minute
    },
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, data: job.data }, 'Execution job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Execution job failed');
  });

  logger.info('Execution worker started');
  return worker;
}

export async function stopExecutionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Execution worker stopped');
  }
}
