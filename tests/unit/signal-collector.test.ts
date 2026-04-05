import { describe, it, expect } from 'vitest';
import {
  extractCIFailureSignal,
  extractDeployFailureSignal,
  parseTodosFromDiff,
  parseCILog,
} from '../../src/services/signal-collector.js';
import type { GitHubCheckRunEvent, GitHubDeploymentStatusEvent } from '../../src/types/index.js';

// ── CI Failure Signal Extraction ──

describe('extractCIFailureSignal', () => {
  const baseEvent: GitHubCheckRunEvent = {
    action: 'completed',
    check_run: {
      id: 123,
      name: 'build',
      conclusion: 'failure',
      output: {
        title: 'Build failed',
        summary: 'TypeScript compilation failed with 3 errors',
        text: 'src/index.ts(15,3): error TS2322: Type string is not assignable to type number',
      },
      html_url: 'https://github.com/org/repo/runs/123',
    },
    repository: { id: 456, full_name: 'org/repo' },
    installation: { id: 789 },
  };

  it('extracts signal from failed check run', () => {
    const result = extractCIFailureSignal(baseEvent);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('CI failure: build');
    expect(result!.severity).toBe('critical');
    expect(result!.logUrl).toBe('https://github.com/org/repo/runs/123');
  });

  it('extracts signal from timed out check run', () => {
    const event = { ...baseEvent, check_run: { ...baseEvent.check_run, conclusion: 'timed_out' as const } };
    const result = extractCIFailureSignal(event);
    expect(result).not.toBeNull();
  });

  it('returns null for successful check run', () => {
    const event = { ...baseEvent, check_run: { ...baseEvent.check_run, conclusion: 'success' as const } };
    expect(extractCIFailureSignal(event)).toBeNull();
  });

  it('returns null for cancelled check run', () => {
    const event = { ...baseEvent, check_run: { ...baseEvent.check_run, conclusion: 'cancelled' as const } };
    expect(extractCIFailureSignal(event)).toBeNull();
  });

  it('handles null output fields', () => {
    const event = {
      ...baseEvent,
      check_run: {
        ...baseEvent.check_run,
        output: { title: null, summary: null, text: null },
      },
    };
    const result = extractCIFailureSignal(event);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('build');
  });

  it('truncates long error messages', () => {
    const longText = 'x'.repeat(3000);
    const event = {
      ...baseEvent,
      check_run: {
        ...baseEvent.check_run,
        output: { title: 'Fail', summary: 'Fail', text: longText },
      },
    };
    const result = extractCIFailureSignal(event);
    expect(result!.errorMessage!.length).toBeLessThanOrEqual(2000);
  });
});

// ── Deploy Failure Signal Extraction ──

describe('extractDeployFailureSignal', () => {
  const baseEvent: GitHubDeploymentStatusEvent = {
    action: 'created',
    deployment_status: {
      state: 'failure',
      description: 'Deploy failed: container health check timeout',
      log_url: 'https://vercel.com/deployments/123',
    },
    deployment: {
      ref: 'main',
      environment: 'production',
    },
    repository: { id: 456, full_name: 'org/repo' },
    installation: { id: 789 },
  };

  it('extracts signal from failed deployment', () => {
    const result = extractDeployFailureSignal(baseEvent);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Deploy failure: production');
    expect(result!.severity).toBe('critical');
  });

  it('extracts signal from error state', () => {
    const event = {
      ...baseEvent,
      deployment_status: { ...baseEvent.deployment_status, state: 'error' as const },
    };
    const result = extractDeployFailureSignal(event);
    expect(result).not.toBeNull();
  });

  it('returns null for successful deployment', () => {
    const event = {
      ...baseEvent,
      deployment_status: { ...baseEvent.deployment_status, state: 'success' as const },
    };
    expect(extractDeployFailureSignal(event)).toBeNull();
  });

  it('returns null for pending deployment', () => {
    const event = {
      ...baseEvent,
      deployment_status: { ...baseEvent.deployment_status, state: 'pending' as const },
    };
    expect(extractDeployFailureSignal(event)).toBeNull();
  });

  it('handles null log_url', () => {
    const event = {
      ...baseEvent,
      deployment_status: { ...baseEvent.deployment_status, log_url: null },
    };
    const result = extractDeployFailureSignal(event);
    expect(result!.logUrl).toBeUndefined();
  });
});

// ── TODO Parsing ──

describe('parseTodosFromDiff', () => {
  it('extracts TODO from added lines', () => {
    const diff = `--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@
 existing line
+// TODO: implement error handling
 another line`;

    const results = parseTodosFromDiff(diff);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('src/app.ts');
    expect(results[0].tag).toBe('TODO');
    expect(results[0].content).toBe('implement error handling');
  });

  it('extracts FIXME tags', () => {
    const diff = `+++ b/src/util.ts
@@ -1,0 +1,2 @@
+// FIXME: race condition in concurrent requests
+const x = 1;`;

    const results = parseTodosFromDiff(diff);
    expect(results).toHaveLength(1);
    expect(results[0].tag).toBe('FIXME');
  });

  it('extracts XXX and HACK tags', () => {
    const diff = `+++ b/src/hack.ts
@@ -1,0 +1,3 @@
+// XXX: temporary workaround
+// HACK: bypass validation for now
+code();`;

    const results = parseTodosFromDiff(diff);
    expect(results).toHaveLength(2);
    expect(results[0].tag).toBe('XXX');
    expect(results[1].tag).toBe('HACK');
  });

  it('ignores removed lines', () => {
    const diff = `+++ b/src/app.ts
@@ -10,3 +10,2 @@
-// TODO: old todo that was removed
 existing line`;

    const results = parseTodosFromDiff(diff);
    expect(results).toHaveLength(0);
  });

  it('handles multiple files', () => {
    const diff = `+++ b/src/a.ts
@@ -1,0 +1,1 @@
+// TODO: fix A
+++ b/src/b.ts
@@ -1,0 +1,1 @@
+// TODO: fix B`;

    const results = parseTodosFromDiff(diff);
    expect(results).toHaveLength(2);
    expect(results[0].file).toBe('src/a.ts');
    expect(results[1].file).toBe('src/b.ts');
  });

  it('returns empty for diff with no TODOs', () => {
    const diff = `+++ b/src/clean.ts
@@ -1,0 +1,2 @@
+const x = 1;
+const y = 2;`;

    expect(parseTodosFromDiff(diff)).toHaveLength(0);
  });
});

// ── CI Log Parsing ──

describe('parseCILog', () => {
  it('detects TypeScript errors', () => {
    const log = `> tsc --noEmit
src/index.ts:15:3 - error TS2322: Type 'string' is not assignable to type 'number'.
Found 1 error.`;

    const result = parseCILog(log);
    expect(result.errorType).toBe('typecheck');
    expect(result.filePaths).toContain('src/index.ts');
  });

  it('detects test failures', () => {
    const log = `FAIL src/app.test.ts
  ● Test suite failed to run
    Test assertion failed
    Expected: 2
    Received: 3`;

    const result = parseCILog(log);
    expect(result.errorType).toBe('test');
  });

  it('detects lint errors', () => {
    const log = `> eslint src/
src/utils.ts:10:5 error no-unused-vars`;

    const result = parseCILog(log);
    expect(result.errorType).toBe('lint');
  });

  it('detects build errors', () => {
    const log = `> webpack build
ERROR in ./src/main.ts
Module build failed`;

    const result = parseCILog(log);
    expect(result.errorType).toBe('build');
  });

  it('extracts file paths from error lines', () => {
    const log = `src/api/routes.ts:42 error
src/lib/db.ts:15 TypeError`;

    const result = parseCILog(log);
    expect(result.filePaths).toContain('src/api/routes.ts');
    expect(result.filePaths).toContain('src/lib/db.ts');
  });

  it('returns unknown for unrecognized log format', () => {
    const log = `Some random output
Process exited with code 1`;

    const result = parseCILog(log);
    expect(result.errorType).toBe('unknown');
  });

  it('limits error lines to 10', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Error line ${i}`).join('\n');
    const result = parseCILog(lines);
    expect(result.errorMessage.split('\n').length).toBeLessThanOrEqual(10);
  });
});
