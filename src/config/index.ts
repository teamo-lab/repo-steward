import 'dotenv/config';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',

  database: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/repo_steward',
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS ?? '10', 10),
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },

  github: {
    appId: process.env.GITHUB_APP_ID ?? '',
    privateKey: process.env.GITHUB_PRIVATE_KEY ?? '',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '4096', 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },

  steward: {
    maxDailySuggestions: parseInt(process.env.MAX_DAILY_SUGGESTIONS ?? '3', 10),
    defaultConfidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.75'),
    discoverySchedule: process.env.DISCOVERY_CRON ?? '0 6 * * *',  // 6 AM daily
    executionTimeout: parseInt(process.env.EXECUTION_TIMEOUT ?? '600000', 10),  // 10 min
  },

  notifications: {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    emailFrom: process.env.EMAIL_FROM ?? 'steward@repo-steward.dev',
    smtpUrl: process.env.SMTP_URL,
  },

  log: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
} as const;

export type Config = typeof config;
