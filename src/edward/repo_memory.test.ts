/**
 * Unit tests for repo_memory.ts
 *
 * Uses $EDWARD_MEMORY_DIR to point at a tmp dir so the real
 * ~/.edward/repo-memory is never touched.
 *
 * Run: bun test src/edward/repo_memory.test.ts
 */

import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import {
  loadRepoMemory,
  saveRepoMemory,
  recordDismissal,
  recordAnswer,
  sanitizeRepoName,
  fingerprintFor,
  memoryPathFor,
  memoryForPrompt,
} from './repo_memory.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'edward-rm-test-'));
  process.env.EDWARD_MEMORY_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.EDWARD_MEMORY_DIR;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('sanitizeRepoName', () => {
  test('joins owner and repo with __', () => {
    expect(sanitizeRepoName('org/repo')).toBe('org__repo');
  });

  test('lowercases everything', () => {
    expect(sanitizeRepoName('FloatMiracle/Ama-User-Service')).toBe('floatmiracle__ama-user-service');
  });

  test('traversal-looking input produces safe filename inside memoryDir', () => {
    // "../etc/passwd" splits on / into ['..', 'etc', 'passwd'].
    // Only owner + repo are kept ('passwd' is dropped), joined with '__',
    // so the result is a literal filename — not a traversal path.
    const safe = sanitizeRepoName('../etc/passwd');
    expect(safe).not.toContain('/');
    expect(safe).not.toContain('\\');
    // Must still join with __
    expect(safe.split('__').length).toBe(2);
    // Path must resolve inside memoryDir, not escape it
    const fullPath = memoryPathFor('../etc/passwd');
    expect(fullPath.startsWith(process.env.EDWARD_MEMORY_DIR!)).toBe(true);
  });

  test('slashes in owner/repo segments never leak through', () => {
    const safe = sanitizeRepoName('evil/../traversal');
    expect(safe).not.toContain('/');
    expect(safe).not.toContain('\\');
  });

  test('handles missing slash', () => {
    const s = sanitizeRepoName('just-repo');
    expect(s).toContain('__');
    expect(s).toMatch(/unknown/);
  });
});

describe('fingerprintFor', () => {
  test('normalizes punctuation and case', () => {
    const a = fingerprintFor('security_fix', 'Alipay ID Exposed!');
    const b = fingerprintFor('security_fix', 'alipay id   exposed');
    expect(a).toBe(b);
  });

  test('different types produce different fingerprints', () => {
    const a = fingerprintFor('security_fix', 'Same title');
    const b = fingerprintFor('code_quality', 'Same title');
    expect(a).not.toBe(b);
  });
});

describe('loadRepoMemory', () => {
  test('returns fresh empty memory when file missing', () => {
    const mem = loadRepoMemory('test-org/test-repo');
    expect(mem.version).toBe(1);
    expect(mem.dismissedFindings).toEqual([]);
    expect(mem.answeredQuestions).toEqual([]);
    expect(mem.repoFullName).toBe('test-org/test-repo');
  });

  test('returns empty memory on malformed JSON', () => {
    const path = memoryPathFor('bad-org/bad-repo');
    // Write garbage to the expected path
    require('node:fs').mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, 'not { json {');
    const mem = loadRepoMemory('bad-org/bad-repo');
    expect(mem.dismissedFindings).toEqual([]);
    expect(mem.answeredQuestions).toEqual([]);
  });

  test('returns empty memory on unsupported version', () => {
    const path = memoryPathFor('old-org/old-repo');
    require('node:fs').mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 999,
      dismissedFindings: [{ type: 'x', title: 'y' }],
    }));
    const mem = loadRepoMemory('old-org/old-repo');
    expect(mem.dismissedFindings).toEqual([]);
  });
});

describe('recordDismissal', () => {
  test('appends a dismissal and persists', () => {
    recordDismissal('test/repo', { type: 'security_fix', title: 'Alipay ID exposed' }, 'not PII here');
    const reloaded = loadRepoMemory('test/repo');
    expect(reloaded.dismissedFindings.length).toBe(1);
    expect(reloaded.dismissedFindings[0].type).toBe('security_fix');
    expect(reloaded.dismissedFindings[0].reason).toBe('not PII here');
    expect(reloaded.dismissedFindings[0].fingerprint).toBeDefined();
  });

  test('deduplicates by fingerprint on repeat dismissal', () => {
    recordDismissal('test/repo', { type: 'security_fix', title: 'Alipay ID exposed' }, 'reason 1');
    recordDismissal('test/repo', { type: 'security_fix', title: 'Alipay ID Exposed' }, 'reason 2');
    const reloaded = loadRepoMemory('test/repo');
    expect(reloaded.dismissedFindings.length).toBe(1);
    expect(reloaded.dismissedFindings[0].reason).toBe('reason 2');
  });

  test('creates the memory dir if missing', () => {
    const inner = join(tmpDir, 'nested', 'deeper');
    process.env.EDWARD_MEMORY_DIR = inner;
    recordDismissal('x/y', { type: 't', title: 'z' }, 'because');
    expect(existsSync(inner)).toBe(true);
    expect(existsSync(join(inner, 'x__y.json'))).toBe(true);
  });
});

describe('recordAnswer', () => {
  test('appends an answer and persists', () => {
    recordAnswer('test/repo', 'q_123', 'Is X allowed?', 'Yes, per compliance.');
    const reloaded = loadRepoMemory('test/repo');
    expect(reloaded.answeredQuestions.length).toBe(1);
    expect(reloaded.answeredQuestions[0].questionId).toBe('q_123');
    expect(reloaded.answeredQuestions[0].answer).toBe('Yes, per compliance.');
  });

  test('overwrites on same questionId', () => {
    recordAnswer('test/repo', 'q_123', 'Q1', 'A1');
    recordAnswer('test/repo', 'q_123', 'Q1', 'A2');
    const reloaded = loadRepoMemory('test/repo');
    expect(reloaded.answeredQuestions.length).toBe(1);
    expect(reloaded.answeredQuestions[0].answer).toBe('A2');
  });

  test('caps answer length at 2000 chars', () => {
    const long = 'x'.repeat(5000);
    recordAnswer('test/repo', 'q_big', 'Q', long);
    const reloaded = loadRepoMemory('test/repo');
    expect(reloaded.answeredQuestions[0].answer.length).toBe(2000);
  });
});

describe('memoryForPrompt', () => {
  test('returns full memory when under budget', () => {
    const mem = loadRepoMemory('test/repo');
    mem.dismissedFindings.push({
      type: 'x', title: 'y', fingerprint: 'x::y',
      dismissedAt: '2026-01-01', reason: 'r',
    });
    const packed = memoryForPrompt(mem, 8000);
    expect(packed.truncated).toBe(false);
    expect(packed.dismissedFindings.length).toBe(1);
  });

  test('drops oldest entries when over budget', () => {
    const mem = loadRepoMemory('test/repo');
    for (let i = 0; i < 100; i++) {
      mem.dismissedFindings.push({
        type: 'type' + i,
        title: 'title ' + 'x'.repeat(100) + i,
        fingerprint: 'fp' + i,
        dismissedAt: new Date().toISOString(),
        reason: 'r'.repeat(200),
      });
    }
    const packed = memoryForPrompt(mem, 1000);
    expect(packed.truncated).toBe(true);
    expect(packed.dismissedFindings.length).toBeLessThan(100);
  });
});
