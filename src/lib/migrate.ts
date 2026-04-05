import { pool } from './db.js';
import { pino } from 'pino';

const logger = pino({ name: 'migrate' });

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS repos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        github_id BIGINT UNIQUE NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT UNIQUE NOT NULL,
        installation_id BIGINT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        language TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        settings JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        github_id BIGINT UNIQUE NOT NULL,
        github_login TEXT UNIQUE NOT NULL,
        email TEXT,
        avatar_url TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        owner_id UUID NOT NULL REFERENCES users(id),
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS team_members (
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (team_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS team_repos (
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        PRIMARY KEY (team_id, repo_id)
      );

      CREATE TABLE IF NOT EXISTS signals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        raw_payload JSONB NOT NULL,
        extracted_data JSONB NOT NULL,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_signals_repo_type ON signals(repo_id, type);
      CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        signal_ids UUID[] NOT NULL DEFAULT '{}',
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'discovered',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence JSONB NOT NULL DEFAULT '{}',
        impact JSONB NOT NULL DEFAULT '{}',
        verification JSONB NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low',
        suggested_at TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        dismiss_reason TEXT,
        snooze_until TIMESTAMPTZ,
        execution_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_repo_status ON tasks(repo_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS executions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued',
        agent_provider TEXT NOT NULL DEFAULT 'claude_code',
        branch_name TEXT NOT NULL,
        pr_number INTEGER,
        pr_url TEXT,
        agent_session_id TEXT,
        logs JSONB NOT NULL DEFAULT '[]',
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);

      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM migrations ORDER BY version DESC LIMIT 1',
    );
    const currentVersion = rows[0]?.version ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        logger.info({ version: migration.version, name: migration.name }, 'Applying migration');
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        );
        await client.query('COMMIT');
        logger.info({ version: migration.version }, 'Migration applied');
      }
    }

    logger.info('All migrations applied');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Run directly
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
