import { pino } from 'pino';
import { query } from '../lib/db.js';
import type {
  Signal,
  SignalType,
  ExtractedSignalData,
  GitHubCheckRunEvent,
  GitHubDeploymentStatusEvent,
} from '../types/index.js';

const logger = pino({ name: 'signal-collector' });

// ── Signal extraction from GitHub events ──

export function extractCIFailureSignal(event: GitHubCheckRunEvent): ExtractedSignalData | null {
  const { check_run } = event;
  if (check_run.conclusion !== 'failure' && check_run.conclusion !== 'timed_out') {
    return null;
  }

  return {
    title: `CI failure: ${check_run.name}`,
    description: check_run.output.summary ?? `Check run "${check_run.name}" failed`,
    errorMessage: check_run.output.text?.slice(0, 2000),
    logUrl: check_run.html_url,
    severity: 'critical',
    metadata: {
      checkRunId: check_run.id,
      checkRunName: check_run.name,
      conclusion: check_run.conclusion,
    },
  };
}

export function extractDeployFailureSignal(
  event: GitHubDeploymentStatusEvent,
): ExtractedSignalData | null {
  const { deployment_status, deployment } = event;
  if (deployment_status.state !== 'failure' && deployment_status.state !== 'error') {
    return null;
  }

  return {
    title: `Deploy failure: ${deployment.environment}`,
    description:
      deployment_status.description ?? `Deployment to ${deployment.environment} failed`,
    logUrl: deployment_status.log_url ?? undefined,
    severity: 'critical',
    metadata: {
      environment: deployment.environment,
      ref: deployment.ref,
      state: deployment_status.state,
    },
  };
}

// ── TODO/FIXME extraction from code ──

export interface TodoMatch {
  file: string;
  line: number;
  content: string;
  tag: 'TODO' | 'FIXME' | 'XXX' | 'HACK';
}

export function parseTodosFromDiff(diff: string): TodoMatch[] {
  const matches: TodoMatch[] = [];
  let currentFile = '';
  let currentLine = 0;

  for (const line of diff.split('\n')) {
    // Parse diff file header
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Parse hunk header for line numbers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Only look at added lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const todoMatch = line.match(/\b(TODO|FIXME|XXX|HACK)\b[:\s]*(.*)/i);
      if (todoMatch) {
        matches.push({
          file: currentFile,
          line: currentLine,
          content: todoMatch[2].trim(),
          tag: todoMatch[1].toUpperCase() as TodoMatch['tag'],
        });
      }
      currentLine++;
    } else if (!line.startsWith('-')) {
      currentLine++;
    }
  }

  return matches;
}

// ── CI log parsing ──

export interface CIErrorExtraction {
  errorType: 'build' | 'test' | 'lint' | 'typecheck' | 'unknown';
  errorMessage: string;
  filePaths: string[];
  suggestion?: string;
}

export function parseCILog(log: string): CIErrorExtraction {
  const lines = log.split('\n');
  const errorLines: string[] = [];
  const filePaths = new Set<string>();

  for (const line of lines) {
    // Collect error lines
    if (/error|fail|Error:|FAIL/i.test(line) && !/warning/i.test(line)) {
      errorLines.push(line.trim());
    }

    // Extract file paths (TypeScript/JavaScript patterns)
    const pathMatch = line.match(/(?:^|\s)([\w./\\-]+\.[tj]sx?):(\d+)/);
    if (pathMatch) {
      filePaths.add(pathMatch[1]);
    }
  }

  // Determine error type
  let errorType: CIErrorExtraction['errorType'] = 'unknown';
  const fullLog = log.toLowerCase();
  if (fullLog.includes('tsc') || fullLog.includes('type error') || fullLog.includes('ts(')) {
    errorType = 'typecheck';
  } else if (fullLog.includes('test') && (fullLog.includes('fail') || fullLog.includes('assert'))) {
    errorType = 'test';
  } else if (fullLog.includes('eslint') || fullLog.includes('lint')) {
    errorType = 'lint';
  } else if (fullLog.includes('build') || fullLog.includes('compile') || fullLog.includes('webpack') || fullLog.includes('esbuild')) {
    errorType = 'build';
  }

  return {
    errorType,
    errorMessage: errorLines.slice(0, 10).join('\n'),
    filePaths: [...filePaths],
  };
}

// ── Signal persistence ──

export async function saveSignal(
  repoId: string,
  type: SignalType,
  source: string,
  rawPayload: Record<string, unknown>,
  extractedData: ExtractedSignalData,
): Promise<Signal> {
  const result = await query(
    `INSERT INTO signals (repo_id, type, source, raw_payload, extracted_data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [repoId, type, source, JSON.stringify(rawPayload), JSON.stringify(extractedData)],
  );

  const row = result.rows[0] as any;
  logger.info({ signalId: row.id, type, repoId }, 'Signal saved');

  return {
    id: row.id,
    repoId: row.repo_id,
    type: row.type as SignalType,
    source: row.source,
    rawPayload: typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload,
    extractedData: typeof row.extracted_data === 'string' ? JSON.parse(row.extracted_data) : row.extracted_data,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

export async function getUnprocessedSignals(repoId: string): Promise<Signal[]> {
  const result = await query(
    `SELECT * FROM signals
     WHERE repo_id = $1 AND processed_at IS NULL
     ORDER BY created_at ASC
     LIMIT 100`,
    [repoId],
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    repoId: row.repo_id,
    type: row.type as SignalType,
    source: row.source,
    rawPayload: row.raw_payload,
    extractedData: row.extracted_data as ExtractedSignalData,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  }));
}

export async function markSignalProcessed(signalId: string): Promise<void> {
  await query('UPDATE signals SET processed_at = NOW() WHERE id = $1', [signalId]);
}
