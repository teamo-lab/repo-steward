import { Queue, Worker } from 'bullmq';
import { pino } from 'pino';
import { redis } from '../lib/redis.js';
import { query } from '../lib/db.js';
import { discoverTasks } from '../services/task-discovery.js';
import { sendDailyDigest } from '../services/notification.js';
import type { DailyDigest } from '../types/index.js';

const logger = pino({ name: 'discovery-scheduler' });

export const discoveryQueue = new Queue('discovery', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
  },
});

interface DiscoveryJobData {
  repoId: string;
  repoFullName: string;
}

async function runDiscovery(data: DiscoveryJobData): Promise<void> {
  const { repoId, repoFullName } = data;
  logger.info({ repoId, repoFullName }, 'Running scheduled discovery');

  try {
    const tasks = await discoverTasks(repoId);

    if (tasks.length > 0) {
      const digest: DailyDigest = {
        date: new Date().toISOString().split('T')[0],
        repoId,
        suggestions: tasks.map((task) => ({
          task,
          actions: {
            approveUrl: `/api/v1/tasks/${task.id}/action`,
            dismissUrl: `/api/v1/tasks/${task.id}/action`,
            snoozeUrl: `/api/v1/tasks/${task.id}/action`,
          },
        })),
        stats: {
          totalDiscovered: tasks.length,
          filteredByConfidence: 0,  // Would track actual filtered count
          suggestedCount: tasks.length,
        },
      };

      await sendDailyDigest(digest);
    }

    logger.info({ repoId, tasksFound: tasks.length }, 'Discovery complete');
  } catch (err) {
    logger.error({ err, repoId }, 'Discovery failed');
    throw err;
  }
}

let worker: Worker | null = null;

export function startDiscoveryWorker(): Worker {
  worker = new Worker<DiscoveryJobData>('discovery', async (job) => {
    await runDiscovery(job.data);
  }, {
    connection: redis,
    concurrency: 3,
  });

  worker.on('completed', (job) => {
    logger.info({ repoId: job.data.repoId }, 'Discovery job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ repoId: job?.data.repoId, err }, 'Discovery job failed');
  });

  logger.info('Discovery worker started');
  return worker;
}

export async function stopDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

// Schedule daily discovery for all active repos
export async function scheduleAllRepos(): Promise<void> {
  const result = await query('SELECT id, full_name FROM repos WHERE is_active = true');

  for (const repo of result.rows as any[]) {
    const jobId = `discovery-${repo.id}-${new Date().toISOString().split('T')[0]}`;

    // Add repeatable job (daily at configured time)
    await discoveryQueue.add(
      'discover',
      { repoId: repo.id, repoFullName: repo.full_name },
      {
        jobId,
        repeat: {
          pattern: '0 6 * * *',  // 6 AM daily
          utc: true,
        },
      },
    );
  }

  logger.info({ repoCount: result.rowCount }, 'Scheduled discovery for all repos');
}
