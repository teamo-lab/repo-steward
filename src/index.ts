import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pino } from 'pino';
import { config } from './config/index.js';
import { registerRoutes } from './api/routes.js';
import { migrate } from './lib/migrate.js';
import { startExecutionWorker, stopExecutionWorker } from './services/task-executor.js';
import { startDiscoveryWorker, stopDiscoveryWorker, scheduleAllRepos } from './workers/discovery-scheduler.js';
import { redis } from './lib/redis.js';
import { closePool } from './lib/db.js';

const logger = pino({ name: 'repo-steward', level: config.log.level });

async function main() {
  logger.info({ env: config.env, port: config.port }, 'Starting Repo Steward');

  // Run database migrations
  try {
    await migrate();
    logger.info('Database migrations complete');
  } catch (err) {
    logger.error({ err }, 'Database migration failed');
    process.exit(1);
  }

  // Create Fastify app
  const app = Fastify({
    logger: {
      level: config.log.level,
    },
  });

  // Register plugins
  await app.register(cors, {
    origin: config.env === 'production' ? ['https://repo-steward.dev'] : true,
    credentials: true,
  });

  // Register routes
  await registerRoutes(app);

  // Start workers
  const executionWorker = startExecutionWorker();
  const discoveryWorker = startDiscoveryWorker();

  // Schedule discovery for all repos
  await scheduleAllRepos();

  // Start HTTP server
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, 'Server listening');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');

    await app.close();
    await stopExecutionWorker();
    await stopDiscoveryWorker();
    await redis.quit();
    await closePool();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
