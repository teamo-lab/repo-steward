/**
 * RepoMemory — per-repo JSON persistence for adjudication signals.
 *
 * This is the smallest possible persistence delta Edward can ship while
 * still solving the "owner rejects the same finding on every scan"
 * problem. One JSON file per repo, lives under
 *
 *   ~/.edward/repo-memory/<owner>__<repo>.json
 *
 * (or under $EDWARD_MEMORY_DIR if set — used by unit tests to avoid
 * touching the real home dir).
 *
 * Two sections:
 *   - dismissedFindings: what the owner has dismissed, and why
 *   - answeredQuestions: what the owner has answered for past open_questions
 *
 * Both are capped at 200 entries each (most recent kept). The file is
 * loaded at the start of every scan and injected into the analysis
 * prompt as REPO_MEMORY. The prompt tells the LLM to cross-reference
 * its candidate findings against this memory and skip anything the
 * owner has already explained.
 *
 * File format is versioned (version: 1) so future schema bumps can be
 * handled without corrupting existing files. Missing + malformed files
 * degrade to fresh empty memory — never throws.
 *
 * Atomic writes: writes go to .tmp file first, then renameSync onto
 * the final path, so a crashed mid-write never leaves a corrupted
 * memory behind.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Public types ──

export interface RepoMemoryDismissedFinding {
  type: string;
  title: string;
  /** Stable dedup key for the LLM to match against on future scans. */
  fingerprint: string;
  dismissedAt: string;
  reason: string;
  scanId?: string;
}

export interface RepoMemoryAnswer {
  questionId: string;
  question: string;
  answer: string;
  answeredAt: string;
  scanId?: string;
}

export interface RepoMemory {
  version: 1;
  repoFullName: string;
  updatedAt: string;
  dismissedFindings: RepoMemoryDismissedFinding[];
  answeredQuestions: RepoMemoryAnswer[];
}

// ── Tunables ──

const MAX_DISMISSED_ENTRIES = 200;
const MAX_ANSWERED_ENTRIES = 200;
const CURRENT_VERSION = 1;

// ── Path helpers ──

/**
 * Resolve the memory directory. Defaults to ~/.edward/repo-memory/ and
 * honors $EDWARD_MEMORY_DIR as an override (tests and transient runs).
 */
export function memoryDir(): string {
  const override = process.env.EDWARD_MEMORY_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.edward', 'repo-memory');
}

/**
 * Sanitize an owner/repo full name into a filesystem-safe filename.
 * Strips everything outside [a-z0-9._-], lowercased, and joins with
 * `__` so "org/repo-name" → "org__repo-name.json".
 *
 * Exported for tests.
 */
export function sanitizeRepoName(fullName: string): string {
  const parts = fullName.split('/');
  const owner = (parts[0] || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const repo = (parts[1] || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `${owner}__${repo}`;
}

/**
 * Absolute path to the JSON file for a given owner/repo.
 */
export function memoryPathFor(repoFullName: string): string {
  return join(memoryDir(), `${sanitizeRepoName(repoFullName)}.json`);
}

/**
 * Build a stable dedup fingerprint for a dismissed finding. The LLM
 * consumes the fingerprint as a hint for cross-scan dedup. We normalize
 * the title (lowercase, collapse whitespace, strip punctuation) so
 * cosmetic variations don't re-surface.
 */
export function fingerprintFor(type: string, title: string): string {
  const normTitle = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${type || 'unknown'}::${normTitle}`;
}

// ── Safe JSON IO ──

function freshMemory(repoFullName: string): RepoMemory {
  return {
    version: CURRENT_VERSION,
    repoFullName,
    updatedAt: new Date().toISOString(),
    dismissedFindings: [],
    answeredQuestions: [],
  };
}

/**
 * Load repo memory for a given fullName. On missing file, malformed
 * JSON, or schema mismatch, returns a fresh empty memory and logs a
 * warning. Never throws.
 */
export function loadRepoMemory(repoFullName: string): RepoMemory {
  const path = memoryPathFor(repoFullName);
  if (!existsSync(path)) return freshMemory(repoFullName);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err: any) {
    console.warn(`[edward] repo-memory: read failed for ${repoFullName}: ${err?.message || err}`);
    return freshMemory(repoFullName);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.warn(`[edward] repo-memory: malformed JSON at ${path}: ${err?.message || err}`);
    return freshMemory(repoFullName);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== CURRENT_VERSION) {
    console.warn(`[edward] repo-memory: unsupported version at ${path}, starting fresh`);
    return freshMemory(repoFullName);
  }
  // Defensive: tolerate missing arrays
  return {
    version: CURRENT_VERSION,
    repoFullName: typeof parsed.repoFullName === 'string' ? parsed.repoFullName : repoFullName,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    dismissedFindings: Array.isArray(parsed.dismissedFindings) ? parsed.dismissedFindings : [],
    answeredQuestions: Array.isArray(parsed.answeredQuestions) ? parsed.answeredQuestions : [],
  };
}

/**
 * Save repo memory atomically. Writes to `<path>.tmp` then renames,
 * so a crashed mid-write never leaves a corrupted memory behind.
 * Caps each section to MAX_* entries (most-recent kept).
 */
export function saveRepoMemory(mem: RepoMemory): void {
  const path = memoryPathFor(mem.repoFullName);
  const dir = memoryDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    console.warn(`[edward] repo-memory: mkdir failed for ${dir}: ${err?.message || err}`);
    return;
  }

  // Cap entries — keep the tail (most recent) since we append new
  // entries to the end of the array in the record* helpers.
  const capped: RepoMemory = {
    version: CURRENT_VERSION,
    repoFullName: mem.repoFullName,
    updatedAt: new Date().toISOString(),
    dismissedFindings: mem.dismissedFindings.slice(-MAX_DISMISSED_ENTRIES),
    answeredQuestions: mem.answeredQuestions.slice(-MAX_ANSWERED_ENTRIES),
  };

  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(capped, null, 2), 'utf-8');
    renameSync(tmpPath, path);
  } catch (err: any) {
    console.warn(`[edward] repo-memory: write failed for ${path}: ${err?.message || err}`);
  }
}

// ── Mutation helpers ──

/**
 * Record a dismissed finding. Loads the existing memory, appends the
 * new entry (deduping by fingerprint so a re-dismiss does not double
 * the file), and atomically saves. Returns the resulting memory for
 * callers that want to chain.
 */
export function recordDismissal(
  repoFullName: string,
  task: { type?: string; title?: string; id?: string },
  reason: string,
  scanId?: string
): RepoMemory {
  const mem = loadRepoMemory(repoFullName);
  const fp = fingerprintFor(task.type || 'unknown', task.title || '');
  // Drop any prior entry with the same fingerprint so the new reason/date win
  mem.dismissedFindings = mem.dismissedFindings.filter(f => f.fingerprint !== fp);
  mem.dismissedFindings.push({
    type: task.type || 'unknown',
    title: task.title || '',
    fingerprint: fp,
    dismissedAt: new Date().toISOString(),
    reason: (reason || '').slice(0, 2000),
    scanId,
  });
  saveRepoMemory(mem);
  return mem;
}

/**
 * Record an answer to an open_question. Same shape as recordDismissal:
 * load, append/dedupe by questionId, save atomically.
 */
export function recordAnswer(
  repoFullName: string,
  questionId: string,
  question: string,
  answer: string,
  scanId?: string
): RepoMemory {
  const mem = loadRepoMemory(repoFullName);
  mem.answeredQuestions = mem.answeredQuestions.filter(a => a.questionId !== questionId);
  mem.answeredQuestions.push({
    questionId,
    question: (question || '').slice(0, 1000),
    answer: (answer || '').slice(0, 2000),
    answeredAt: new Date().toISOString(),
    scanId,
  });
  saveRepoMemory(mem);
  return mem;
}

/**
 * Build a compact projection of repo memory suitable for injecting
 * into the LLM prompt. Caps the serialized size to `maxBytes`, dropping
 * oldest entries first, so a noisy repo cannot blow up the prompt.
 *
 * Returns a JSON-safe object (not a string) — caller is responsible
 * for JSON.stringify-ing it into the prompt template.
 */
export function memoryForPrompt(
  mem: RepoMemory,
  maxBytes: number = 8 * 1024
): {
  version: 1;
  dismissedFindings: RepoMemoryDismissedFinding[];
  answeredQuestions: RepoMemoryAnswer[];
  truncated: boolean;
} {
  // Start with all entries, drop oldest until the serialized size fits.
  let dismissed = [...mem.dismissedFindings];
  let answered = [...mem.answeredQuestions];
  let truncated = false;
  const pack = () => ({
    version: CURRENT_VERSION as 1,
    dismissedFindings: dismissed,
    answeredQuestions: answered,
    truncated,
  });
  while (JSON.stringify(pack()).length > maxBytes) {
    // Trim whichever section is longer
    if (dismissed.length >= answered.length && dismissed.length > 0) {
      dismissed.shift();
    } else if (answered.length > 0) {
      answered.shift();
    } else {
      break;
    }
    truncated = true;
  }
  return pack();
}
