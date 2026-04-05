import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query } from '../lib/db.js';
import { healthCheck } from '../lib/db.js';
import { redisHealthCheck } from '../lib/redis.js';
import { getSuggestions, discoverTasks } from '../services/task-discovery.js';
import { approveTask, dismissTask, snoozeTask } from '../services/task-executor.js';
import type { TaskActionRequest, UserAction } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Schemas ──

const taskActionSchema = z.object({
  action: z.enum(['approve', 'dismiss', 'snooze']),
  reason: z.string().optional(),
  snoozeUntil: z.string().datetime().optional(),
});

const repoIdParam = z.object({
  repoId: z.string().uuid(),
});

const taskIdParam = z.object({
  taskId: z.string().uuid(),
});

// ── Route registration ──

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Dashboard ──

  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    const html = readFileSync(join(__dirname, '..', 'dashboard.html'), 'utf-8');
    return reply.type('text/html').send(html);
  });

  // ── Health ──

  app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [dbOk, redisOk] = await Promise.all([healthCheck(), redisHealthCheck()]);
    const status = dbOk && redisOk ? 'healthy' : 'degraded';
    const code = status === 'healthy' ? 200 : 503;

    return reply.status(code).send({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        database: dbOk ? 'ok' : 'fail',
        redis: redisOk ? 'ok' : 'fail',
      },
    });
  });

  app.get('/ready', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ ready: true });
  });

  // ── Repos ──

  app.get('/api/v1/repos', async (_req: FastifyRequest, reply: FastifyReply) => {
    const result = await query('SELECT * FROM repos WHERE is_active = true ORDER BY full_name');
    return reply.send({ repos: result.rows });
  });

  app.get('/api/v1/repos/:repoId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { repoId } = repoIdParam.parse(req.params);
    const result = await query('SELECT * FROM repos WHERE id = $1', [repoId]);
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Repo not found' });
    }
    return reply.send({ repo: result.rows[0] });
  });

  app.post('/api/v1/repos', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ full_name: z.string().regex(/^[^/]+\/[^/]+$/) }).parse(req.body);
    const [owner, name] = body.full_name.split('/');

    // Check if already exists
    const existing = await query('SELECT * FROM repos WHERE full_name = $1', [body.full_name]);
    if (existing.rows.length > 0) {
      return reply.send({ repo: existing.rows[0], created: false });
    }

    // Try to fetch repo info from GitHub API
    let githubId = Math.floor(Math.random() * 900000000) + 100000000;
    let language = 'Unknown';
    let defaultBranch = 'main';

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${body.full_name}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'repo-steward' },
      });
      if (ghRes.ok) {
        const ghData = await ghRes.json() as any;
        githubId = ghData.id;
        language = ghData.language || 'Unknown';
        defaultBranch = ghData.default_branch || 'main';
      }
    } catch {
      // Use defaults if GitHub API is unreachable
    }

    const result = await query(
      `INSERT INTO repos (id, github_id, full_name, owner, name, installation_id, language, default_branch, is_active, settings, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, $5, $6, true, '{}', NOW(), NOW())
       RETURNING *`,
      [githubId, body.full_name, owner, name, language, defaultBranch],
    );
    return reply.status(201).send({ repo: result.rows[0], created: true });
  });

  app.patch('/api/v1/repos/:repoId/settings', async (req: FastifyRequest, reply: FastifyReply) => {
    const { repoId } = repoIdParam.parse(req.params);
    const settings = req.body;
    await query(
      `UPDATE repos SET settings = settings || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(settings), repoId],
    );
    const result = await query('SELECT * FROM repos WHERE id = $1', [repoId]);
    return reply.send({ repo: result.rows[0] });
  });

  // ── Tasks / Suggestions ──

  app.get('/api/v1/repos/:repoId/suggestions', async (req: FastifyRequest, reply: FastifyReply) => {
    const { repoId } = repoIdParam.parse(req.params);
    const suggestions = await getSuggestions(repoId);
    return reply.send({
      suggestions: suggestions.map((task) => ({
        task,
        actions: {
          approveUrl: `/api/v1/tasks/${task.id}/action`,
          dismissUrl: `/api/v1/tasks/${task.id}/action`,
          snoozeUrl: `/api/v1/tasks/${task.id}/action`,
        },
      })),
    });
  });

  app.post('/api/v1/repos/:repoId/discover', async (req: FastifyRequest, reply: FastifyReply) => {
    const { repoId } = repoIdParam.parse(req.params);
    const tasks = await discoverTasks(repoId);
    return reply.send({ tasks, count: tasks.length });
  });

  app.get('/api/v1/repos/:repoId/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const { repoId } = repoIdParam.parse(req.params);
    const { status, type, limit = '50', offset = '0' } = req.query as Record<string, string>;

    let sql = 'SELECT * FROM tasks WHERE repo_id = $1';
    const params: unknown[] = [repoId];
    let paramIdx = 2;

    if (status) {
      sql += ` AND status = $${paramIdx++}`;
      params.push(status);
    }
    if (type) {
      sql += ` AND type = $${paramIdx++}`;
      params.push(type);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await query(sql, params);
    return reply.send({ tasks: result.rows, count: result.rowCount });
  });

  app.get('/api/v1/tasks/:taskId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = taskIdParam.parse(req.params);
    const result = await query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Task not found' });
    }
    return reply.send({ task: result.rows[0] });
  });

  app.post('/api/v1/tasks/:taskId/action', async (req: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = taskIdParam.parse(req.params);
    const body = taskActionSchema.parse(req.body);

    switch (body.action) {
      case 'approve': {
        const execution = await approveTask(taskId);
        return reply.send({ status: 'approved', execution });
      }
      case 'dismiss': {
        await dismissTask(taskId, body.reason);
        return reply.send({ status: 'dismissed' });
      }
      case 'snooze': {
        if (!body.snoozeUntil) {
          return reply.status(400).send({ error: 'snoozeUntil is required for snooze action' });
        }
        await snoozeTask(taskId, new Date(body.snoozeUntil));
        return reply.send({ status: 'snoozed', until: body.snoozeUntil });
      }
    }
  });

  // ── Executions ──

  app.get('/api/v1/tasks/:taskId/execution', async (req: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = taskIdParam.parse(req.params);
    const result = await query(
      'SELECT * FROM executions WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
      [taskId],
    );
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'No execution found' });
    }
    return reply.send({ execution: result.rows[0] });
  });

  app.get('/api/v1/executions', async (req: FastifyRequest, reply: FastifyReply) => {
    const { status, limit = '20' } = req.query as Record<string, string>;
    let sql = 'SELECT * FROM executions';
    const params: unknown[] = [];

    if (status) {
      sql += ' WHERE status = $1';
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const result = await query(sql, params);
    return reply.send({ executions: result.rows });
  });

  // ── Stats ──

  app.get('/api/v1/repos/:repoId/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    const { repoId } = repoIdParam.parse(req.params);

    const [tasksResult, executionsResult] = await Promise.all([
      query(
        `SELECT
           status,
           COUNT(*) as count
         FROM tasks
         WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY status`,
        [repoId],
      ),
      query(
        `SELECT
           status,
           COUNT(*) as count
         FROM executions
         WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY status`,
        [repoId],
      ),
    ]);

    const taskStats = Object.fromEntries(
      tasksResult.rows.map((r: any) => [r.status, parseInt(r.count, 10)]),
    );
    const execStats = Object.fromEntries(
      executionsResult.rows.map((r: any) => [r.status, parseInt(r.count, 10)]),
    );

    const totalSuggested = (taskStats.suggested ?? 0) + (taskStats.approved ?? 0) +
      (taskStats.executing ?? 0) + (taskStats.pr_created ?? 0) +
      (taskStats.verified ?? 0) + (taskStats.merged ?? 0) +
      (taskStats.dismissed ?? 0);
    const totalAccepted = (taskStats.approved ?? 0) + (taskStats.executing ?? 0) +
      (taskStats.pr_created ?? 0) + (taskStats.verified ?? 0) + (taskStats.merged ?? 0);
    const acceptanceRate = totalSuggested > 0 ? totalAccepted / totalSuggested : 0;
    const mergeRate = totalAccepted > 0 ? (taskStats.merged ?? 0) / totalAccepted : 0;

    return reply.send({
      period: '30d',
      tasks: taskStats,
      executions: execStats,
      metrics: {
        acceptanceRate: Math.round(acceptanceRate * 100),
        mergeRate: Math.round(mergeRate * 100),
        totalSuggested,
        totalAccepted,
        totalMerged: taskStats.merged ?? 0,
      },
    });
  });

  // ── Webhooks ──

  app.post('/api/v1/webhooks/github', async (req: FastifyRequest, reply: FastifyReply) => {
    // Webhook signature verification would go here
    const event = req.headers['x-github-event'] as string;
    const payload = req.body as Record<string, unknown>;

    switch (event) {
      case 'check_run':
        // Process in background
        setImmediate(() => {
          processCheckRunEvent(payload).catch((err) => {
            console.error('Failed to process check_run event:', err);
          });
        });
        break;

      case 'deployment_status':
        setImmediate(() => {
          processDeploymentStatusEvent(payload).catch((err) => {
            console.error('Failed to process deployment_status event:', err);
          });
        });
        break;

      default:
        // Ignore other events
        break;
    }

    return reply.status(200).send({ ok: true });
  });
}

// ── Webhook processors ──

async function processCheckRunEvent(payload: Record<string, unknown>): Promise<void> {
  // Import dynamically to avoid circular dependencies
  const { extractCIFailureSignal, saveSignal } = await import('../services/signal-collector.js');
  const event = payload as unknown as import('../types/index.js').GitHubCheckRunEvent;

  if (event.action !== 'completed') return;

  const extracted = extractCIFailureSignal(event);
  if (!extracted) return;

  // Find repo by github_id
  const repoResult = await query(
    'SELECT id FROM repos WHERE github_id = $1',
    [event.repository.id],
  );
  if (repoResult.rows.length === 0) return;

  const repoId = (repoResult.rows[0] as any).id;
  await saveSignal(repoId, 'ci_failure', 'github_actions', payload, extracted);
}

async function processDeploymentStatusEvent(payload: Record<string, unknown>): Promise<void> {
  const { extractDeployFailureSignal, saveSignal } = await import('../services/signal-collector.js');
  const event = payload as unknown as import('../types/index.js').GitHubDeploymentStatusEvent;

  if (event.action !== 'created') return;

  const extracted = extractDeployFailureSignal(event);
  if (!extracted) return;

  const repoResult = await query(
    'SELECT id FROM repos WHERE github_id = $1',
    [event.repository.id],
  );
  if (repoResult.rows.length === 0) return;

  const repoId = (repoResult.rows[0] as any).id;
  await saveSignal(repoId, 'deploy_failure', 'github_deployment', payload, extracted);
}
