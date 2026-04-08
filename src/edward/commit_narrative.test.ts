/**
 * Unit tests for commit_narrative.ts
 *
 * Run: bun test src/edward/commit_narrative.test.ts
 *
 * We deliberately avoid exercising the real git shell-out path in most
 * tests — the helpers we care about (conventional-commit parsing,
 * incident marker extraction, theme aggregation) are pure functions
 * and exported directly for this reason. One end-to-end test hits a
 * non-git directory to verify graceful degradation.
 */

import { expect, test, describe } from 'bun:test';
import {
  detectCommitNarrative,
  extractConventionalType,
  extractIncidentMarkers,
  aggregateThemes,
} from './commit_narrative.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('extractConventionalType', () => {
  test('matches feat/fix/refactor with colon', () => {
    expect(extractConventionalType('feat: add payout endpoint')).toBe('feat');
    expect(extractConventionalType('fix: null pointer on empty cart')).toBe('fix');
    expect(extractConventionalType('refactor: extract repo_memory module')).toBe('refactor');
  });

  test('matches scoped conventional commits', () => {
    expect(extractConventionalType('feat(api): new endpoint')).toBe('feat');
    expect(extractConventionalType('fix(server): port-in-use hint')).toBe('fix');
    expect(extractConventionalType('perf(ci): cache install step')).toBe('perf');
  });

  test('matches breaking-change marker', () => {
    expect(extractConventionalType('feat!: drop node 14 support')).toBe('feat');
    expect(extractConventionalType('refactor(core)!: rename handler')).toBe('refactor');
  });

  test('rejects narrative prose without colon', () => {
    // "fix the thing" looks like it starts with fix but is missing
    // the colon — this is prose, not a conventional commit.
    expect(extractConventionalType('fix the thing')).toBeNull();
    expect(extractConventionalType('added a new test case')).toBeNull();
  });

  test('rejects empty/null-ish input', () => {
    expect(extractConventionalType('')).toBeNull();
    expect(extractConventionalType('   ')).toBeNull();
  });

  test('rejects unknown prefixes even with colon', () => {
    expect(extractConventionalType('banana: something')).toBeNull();
    expect(extractConventionalType('wip: draft')).toBeNull();
  });

  test('case-insensitive prefix recognition', () => {
    expect(extractConventionalType('FIX: something broken')).toBe('fix');
    expect(extractConventionalType('Feat: add thing')).toBe('feat');
  });
});

describe('extractIncidentMarkers', () => {
  test('returns empty array for non-incident subjects', () => {
    expect(extractIncidentMarkers('feat: add new endpoint')).toEqual([]);
    expect(extractIncidentMarkers('refactor: extract helper')).toEqual([]);
  });

  test('picks up fix + rollback in same subject', () => {
    const markers = extractIncidentMarkers('fix: rollback broken migration');
    expect(markers).toContain('fix');
    expect(markers).toContain('rollback');
  });

  test('picks up p0/p1/p2 severity markers', () => {
    expect(extractIncidentMarkers('p0 outage: login broken')).toContain('p0');
    expect(extractIncidentMarkers('p1: rate limiter down')).toContain('p1');
    expect(extractIncidentMarkers('p2 flaky test')).toContain('p2');
  });

  test('picks up hotfix / incident / urgent / regression', () => {
    expect(extractIncidentMarkers('hotfix: payment double-charge')).toContain('hotfix');
    expect(extractIncidentMarkers('incident postmortem applied')).toContain('incident');
    expect(extractIncidentMarkers('urgent: revert last release')).toContain('urgent');
    expect(extractIncidentMarkers('regression in search results')).toContain('regression');
  });

  test('deduplicates repeated markers', () => {
    // "fix fix fix" should return ['fix'] not ['fix','fix','fix']
    const markers = extractIncidentMarkers('fix fix fix the thing');
    expect(markers.filter(m => m === 'fix').length).toBe(1);
  });

  test('empty input returns empty', () => {
    expect(extractIncidentMarkers('')).toEqual([]);
  });
});

describe('aggregateThemes', () => {
  test('groups commits by matching keyword and counts', () => {
    const commits = [
      { date: '2026-01-01', subject: 'feat: alipay refund button' },
      { date: '2026-01-05', subject: 'fix: alipay webhook retry' },
      { date: '2026-02-01', subject: 'fix: refund race condition' },
      { date: '2026-02-10', subject: 'chore: bump dep' },
    ];
    const themes = aggregateThemes(commits);

    const alipay = themes.find(t => t.keyword === 'alipay');
    expect(alipay).toBeDefined();
    expect(alipay!.occurrences).toBe(2);
    expect(alipay!.sampleSubjects.length).toBeLessThanOrEqual(3);

    const refund = themes.find(t => t.keyword === 'refund');
    expect(refund).toBeDefined();
    expect(refund!.occurrences).toBe(2);
  });

  test('drops single-occurrence themes as noise', () => {
    const commits = [
      { date: '2026-01-01', subject: 'feat: alipay refund button' },
    ];
    const themes = aggregateThemes(commits);
    // 1 occurrence each — both should be dropped
    expect(themes.length).toBe(0);
  });

  test('sorts themes by occurrence descending', () => {
    const commits = [
      { date: '2026-01-01', subject: 'feat: alipay thing' },
      { date: '2026-01-02', subject: 'feat: alipay other' },
      { date: '2026-01-03', subject: 'fix: alipay bug' },
      { date: '2026-01-04', subject: 'fix: timeout issue' },
      { date: '2026-01-05', subject: 'fix: timeout again' },
    ];
    const themes = aggregateThemes(commits);
    // alipay should come before timeout
    const alipayIdx = themes.findIndex(t => t.keyword === 'alipay');
    const timeoutIdx = themes.findIndex(t => t.keyword === 'timeout');
    expect(alipayIdx).toBeGreaterThanOrEqual(0);
    expect(timeoutIdx).toBeGreaterThan(alipayIdx);
  });

  test('tracks first-seen and last-seen dates', () => {
    const commits = [
      { date: '2026-03-01', subject: 'feat: alipay rollout' },
      { date: '2026-01-15', subject: 'fix: alipay edge case' },
      { date: '2026-02-20', subject: 'fix: alipay retry logic' },
    ];
    const themes = aggregateThemes(commits);
    const alipay = themes.find(t => t.keyword === 'alipay');
    expect(alipay).toBeDefined();
    expect(alipay!.firstSeen).toBe('2026-01-15');
    expect(alipay!.lastSeen).toBe('2026-03-01');
  });

  test('caps sample subjects at 3', () => {
    const commits = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      subject: `feat: alipay change ${i}`,
    }));
    const themes = aggregateThemes(commits);
    const alipay = themes.find(t => t.keyword === 'alipay');
    expect(alipay).toBeDefined();
    expect(alipay!.sampleSubjects.length).toBeLessThanOrEqual(3);
    expect(alipay!.occurrences).toBe(10);
  });

  test('empty input returns empty array', () => {
    expect(aggregateThemes([])).toEqual([]);
  });
});

describe('detectCommitNarrative — graceful degradation', () => {
  test('returns empty narrative for non-existent repoDir', () => {
    const narrative = detectCommitNarrative('/tmp/definitely-not-a-real-path-' + Date.now());
    expect(narrative.trajectories).toEqual([]);
    expect(narrative.themes).toEqual([]);
    expect(narrative.incidents).toEqual([]);
    expect(narrative.notes.length).toBeGreaterThan(0);
    expect(narrative.notes.some(n => /does not exist/i.test(n))).toBe(true);
  });

  test('returns empty narrative for dir that is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edward-cn-test-'));
    try {
      // Write a file but no .git dir
      writeFileSync(join(dir, 'hello.txt'), 'world');
      const narrative = detectCommitNarrative(dir);
      expect(narrative.trajectories).toEqual([]);
      expect(narrative.themes).toEqual([]);
      expect(narrative.incidents).toEqual([]);
      expect(narrative.notes.some(n => /not a git repository/i.test(n))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('output shape is stable — all required top-level fields present', () => {
    const narrative = detectCommitNarrative('/tmp/nope-' + Date.now());
    expect(narrative).toHaveProperty('generatedAt');
    expect(narrative).toHaveProperty('windowDays');
    expect(narrative).toHaveProperty('trajectories');
    expect(narrative).toHaveProperty('themes');
    expect(narrative).toHaveProperty('incidents');
    expect(narrative).toHaveProperty('notes');
    expect(typeof narrative.generatedAt).toBe('string');
    expect(typeof narrative.windowDays).toBe('number');
  });

  test('respects custom windowDays option', () => {
    const narrative = detectCommitNarrative('/tmp/nope-' + Date.now(), { windowDays: 30 });
    expect(narrative.windowDays).toBe(30);
  });
});
