/**
 * CommitNarrative — Layer 4 of the discover pipeline.
 *
 * Mines the git history of a cloned repo and produces a compact summary
 * of what the repo has been actively working on. The output is injected
 * into the analysis prompt alongside REPO_PROFILE / CI_CONFIG_FILES /
 * HOT_MODULES so the LLM can calibrate its findings against the team's
 * recent trajectory instead of scanning the code in a context-free
 * vacuum.
 *
 * Three sections:
 *
 *   1. moduleTrajectories  — per top-level source dir + per hot module,
 *      how often the code there is changing, when, and in what shape
 *      (feat/fix/refactor counts, recent subjects). Used by the prompt
 *      to detect "this team has been actively refining X — be cautious
 *      before claiming X is broken".
 *
 *   2. recurringThemes     — keyword co-occurrence across commit
 *      subjects. Surfaces domain concepts the repo keeps returning to
 *      ("alipay", "refund", "timeout", "rollback") so the LLM knows
 *      what the business actually cares about.
 *
 *   3. recentIncidents     — commits in the last 90 days whose subject
 *      matches /fix|revert|rollback|hotfix|incident|urgent|p[0-2]/i.
 *      These are the "we already got burned here" breadcrumbs. Phase
 *      1.5 is instructed to prioritize files touched by these commits
 *      alongside the hot-module list.
 *
 * All git calls are wrapped in try/catch and degrade to an empty shape
 * on any failure (shallow clone with no history, git not installed,
 * submodule confusion, etc.). Empty narrative = no-op for the prompt;
 * existing behavior continues unchanged.
 *
 * Zero runtime dependencies — shells out to `git` via node:child_process,
 * same pattern as hot_modules.ts.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execSync } from 'node:child_process';

// ── Public types ──

export interface ModuleTrajectory {
  /** Top-level directory OR hot-module path (relative to repoDir). */
  path: string;
  /** True if this path came from the HOT_MODULES list. */
  isHotModule: boolean;
  /** Commits touching this path in the last `windowDays`. */
  commitCount: number;
  /** ISO date of earliest commit in window, or empty string if none. */
  firstChange: string;
  /** ISO date of latest commit in window, or empty string if none. */
  lastChange: string;
  /** Up to 5 most recent non-trivial commit subjects. */
  recentSubjects: string[];
  /** Conventional-commit type counts: { feat: 3, fix: 7, refactor: 1, ... }. */
  conventionalTypes: Record<string, number>;
}

export interface RecurringTheme {
  /** Lowercased keyword. */
  keyword: string;
  /** Count across commit subjects in window. */
  occurrences: number;
  /** ISO date of earliest occurrence. */
  firstSeen: string;
  /** ISO date of latest occurrence. */
  lastSeen: string;
  /** Up to 3 representative subjects that mention the keyword. */
  sampleSubjects: string[];
}

export interface RecentIncident {
  /** Short SHA (7 chars). */
  sha: string;
  /** ISO date of the commit. */
  date: string;
  /** Commit subject line. */
  subject: string;
  /** Incident-like keywords matched in the subject. */
  incidentMarkers: string[];
  /** Up to 10 files this commit touched. */
  filesTouched: string[];
}

export interface CommitNarrative {
  generatedAt: string;
  /** Nominal window. Actual data may be less if the clone is shallow. */
  windowDays: number;
  trajectories: ModuleTrajectory[];
  themes: RecurringTheme[];
  incidents: RecentIncident[];
  /** Diagnostic notes, e.g. "only 30 days of history available". */
  notes: string[];
}

// ── Tunables ──

const DEFAULT_WINDOW_DAYS = 365;
const INCIDENT_WINDOW_DAYS = 90;
const MAX_TRAJECTORIES = 20;
const MAX_THEMES = 10;
const MAX_INCIDENTS = 15;
const MAX_RECENT_SUBJECTS = 5;
const MAX_FILES_PER_INCIDENT = 10;
const MAX_COMMITS_FOR_PARSING = 2000;

// Conventional-commit prefixes we track separately
const CONVENTIONAL_PREFIXES = [
  'feat', 'fix', 'refactor', 'perf', 'chore', 'docs',
  'test', 'build', 'ci', 'revert', 'style',
];

// Incident-like keywords in commit subjects (case-insensitive match)
const INCIDENT_REGEX = /\b(fix|fixup|revert|rollback|hotfix|incident|urgent|p[0-2]|outage|regression|emergency)\b/i;

// Theme candidate keywords to extract from commit subjects. We do not
// try to learn them — we whitelist ~40 common business/infra concepts
// that repeatedly surface as high-signal themes in real production
// repos. The LLM consumes the list and can reason about the rest.
const THEME_KEYWORDS = [
  // Payments / finance
  'alipay', 'wechat', 'stripe', 'payment', 'refund', 'payout',
  'charge', 'invoice', 'billing', 'subscription', 'rewards',
  // Auth / access
  'auth', 'login', 'oauth', 'jwt', 'session', 'token', 'permission',
  // Ops / reliability
  'timeout', 'retry', 'rollback', 'migration', 'deploy', 'release',
  'rate-limit', 'ratelimit', 'throttle', 'queue', 'cache',
  // Data integrity
  'conflict', 'dedupe', 'idempotent', 'transaction', 'consistency',
  'migration', 'backfill', 'cleanup',
  // External integrations
  'webhook', 'callback', 'api', 'notification', 'sms', 'email',
  // Performance
  'slow', 'perf', 'latency', 'memory', 'leak', 'crash', 'oom',
];

// Subject lines shorter than this are usually "wip", "fix", "tmp" etc.
const MIN_NON_TRIVIAL_SUBJECT_LEN = 12;

// Path fragments we do NOT treat as top-level source dirs for trajectories
const EXCLUDE_TOP_DIRS = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', 'coverage',
  '.cache', '.idea', '.vscode', 'vendor', 'third_party',
]);

// Source-looking extensions, used to decide whether a top-level dir
// actually contains code (we don't want to create a trajectory for
// /docs/).
const SOURCE_EXT_HINTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs',
  '.swift', '.scala', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.proto',
]);

// ── Safe helpers ──

function safeExists(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

function safeExec(cmd: string, cwd: string, timeoutMs = 20_000): string | null {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 100_000_000,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function isGitRepo(repoDir: string): boolean {
  return safeExists(join(repoDir, '.git'));
}

// ── Subject parsing helpers ──

/**
 * Extract the conventional-commit type prefix from a commit subject,
 * or return null if none is present.
 *
 * Matches: feat:, fix(parser):, perf!:, refactor(ci):.
 * Does NOT match: "fix the thing" — we require the colon to avoid
 * false positives on narrative subjects.
 */
export function extractConventionalType(subject: string): string | null {
  if (!subject) return null;
  // Match: type, optional (scope), optional !, required :
  const m = /^([a-z]+)(?:\([^)]+\))?!?:/i.exec(subject.trim());
  if (!m || !m[1]) return null;
  const type = m[1].toLowerCase();
  return CONVENTIONAL_PREFIXES.includes(type) ? type : null;
}

/**
 * Return the list of incident markers found in a commit subject.
 * Returns empty array when the subject does not look like an incident.
 */
export function extractIncidentMarkers(subject: string): string[] {
  if (!subject) return [];
  const found = new Set<string>();
  // INCIDENT_REGEX matches the first one; we want all of them.
  const re = /\b(fix|fixup|revert|rollback|hotfix|incident|urgent|p[0-2]|outage|regression|emergency)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(subject)) !== null) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return [...found];
}

/**
 * Aggregate theme occurrences across a flat list of subjects. Exported
 * so the unit test can feed it hand-built subjects without touching git.
 */
export function aggregateThemes(
  commits: Array<{ date: string; subject: string }>
): RecurringTheme[] {
  const buckets = new Map<string, {
    count: number;
    firstSeen: string;
    lastSeen: string;
    samples: string[];
  }>();

  for (const c of commits) {
    if (!c.subject) continue;
    const lower = c.subject.toLowerCase();
    for (const kw of THEME_KEYWORDS) {
      if (!lower.includes(kw)) continue;
      let b = buckets.get(kw);
      if (!b) {
        b = { count: 0, firstSeen: c.date, lastSeen: c.date, samples: [] };
        buckets.set(kw, b);
      }
      b.count++;
      if (c.date < b.firstSeen) b.firstSeen = c.date;
      if (c.date > b.lastSeen) b.lastSeen = c.date;
      if (b.samples.length < 3) b.samples.push(c.subject);
    }
  }

  const themes: RecurringTheme[] = [];
  for (const [keyword, b] of buckets) {
    if (b.count < 2) continue; // one-off mentions are noise
    themes.push({
      keyword,
      occurrences: b.count,
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen,
      sampleSubjects: b.samples,
    });
  }
  themes.sort((a, b) => b.occurrences - a.occurrences);
  return themes.slice(0, MAX_THEMES);
}

// ── Top-level source dir discovery ──

/**
 * Enumerate top-level directories that look like they contain source
 * code. Used to seed the trajectory list when the hot-module list is
 * short or empty.
 */
function listTopLevelSourceDirs(repoDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(repoDir);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (EXCLUDE_TOP_DIRS.has(entry)) continue;
    const abs = join(repoDir, entry);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(abs);
    } catch { continue; }
    if (!s.isDirectory()) continue;

    // Cheap signal: at least one file in the first level with a source
    // extension. Avoids creating trajectories for /docs, /images, /fonts.
    let hasSourceChild = false;
    try {
      const children = readdirSync(abs);
      for (const c of children) {
        if (SOURCE_EXT_HINTS.has(extname(c).toLowerCase())) {
          hasSourceChild = true;
          break;
        }
        // One level of recursion for repos that wrap everything in
        // another subdir (e.g. ./src/foo/bar.ts). Cheap and bounded.
        try {
          const sub = statSync(join(abs, c));
          if (sub.isDirectory()) {
            const grandChildren = readdirSync(join(abs, c));
            for (const gc of grandChildren) {
              if (SOURCE_EXT_HINTS.has(extname(gc).toLowerCase())) {
                hasSourceChild = true;
                break;
              }
            }
          }
        } catch { /* skip */ }
        if (hasSourceChild) break;
      }
    } catch { /* skip */ }

    if (hasSourceChild) results.push(entry);
  }
  return results;
}

// ── git log fetchers ──

interface ParsedCommit {
  sha: string;
  date: string;      // YYYY-MM-DD
  subject: string;
  files: string[];
}

/**
 * Parse a single `git log --pretty=format:%h%x09%ad%x09%s --name-only`
 * stream into per-commit objects. We use tab separators because subject
 * lines can contain almost any punctuation including commas and colons.
 */
function parseGitLogNameOnly(text: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  // Split on blank lines — git prints a blank line between commits
  // when using --name-only. We do manual parsing because the first
  // line of each block is the header, the rest are file paths.
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    // Skip leading blank lines
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    const header = lines[i++];
    const parts = header.split('\t');
    if (parts.length < 3) continue;
    const sha = parts[0]?.slice(0, 7) || '';
    const date = parts[1]?.slice(0, 10) || '';
    const subject = parts.slice(2).join('\t');
    const files: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const f = lines[i++].trim();
      if (f) files.push(f);
    }
    if (sha && date && subject) {
      commits.push({ sha, date, subject, files });
    }
    if (commits.length >= MAX_COMMITS_FOR_PARSING) break;
  }
  return commits;
}

// ── Main entry ──

export function detectCommitNarrative(
  repoDir: string,
  opts?: { hotModulePaths?: string[]; windowDays?: number }
): CommitNarrative {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const hotModulePaths = opts?.hotModulePaths ?? [];
  const notes: string[] = [];

  const empty: CommitNarrative = {
    generatedAt: new Date().toISOString(),
    windowDays,
    trajectories: [],
    themes: [],
    incidents: [],
    notes,
  };

  if (!safeExists(repoDir)) {
    notes.push(`repoDir does not exist: ${repoDir}`);
    return empty;
  }
  if (!isGitRepo(repoDir)) {
    notes.push('not a git repository (no .git dir) — narrative unavailable');
    return empty;
  }

  // Fetch all commits in window with file lists. Use ISO dates so the
  // downstream parsing is stable across locales. --no-merges strips the
  // merge bubble subjects which are usually just "Merge pull request ...".
  const sinceFlag = `--since="${windowDays} days ago"`;
  const logCmd =
    `git log --no-merges ${sinceFlag} ` +
    `--date=short --pretty=format:%h%x09%ad%x09%s --name-only`;
  const raw = safeExec(logCmd, repoDir);
  if (raw === null) {
    notes.push('git log failed — narrative unavailable');
    return empty;
  }
  if (!raw.trim()) {
    notes.push(`no commits in the last ${windowDays} days`);
    return empty;
  }

  const commits = parseGitLogNameOnly(raw);
  if (commits.length === 0) {
    notes.push('git log parsed to zero commits (unexpected format)');
    return empty;
  }

  // Diagnostic: if the earliest commit is much newer than the window,
  // we probably have a shallow clone. Flag it so the LLM knows not to
  // over-interpret.
  const oldest = commits[commits.length - 1]?.date;
  if (oldest) {
    const msSinceOldest = Date.now() - new Date(oldest).getTime();
    const actualDays = Math.round(msSinceOldest / (1000 * 60 * 60 * 24));
    if (actualDays < windowDays / 2) {
      notes.push(`only ~${actualDays} days of history available (likely shallow clone)`);
    }
  }

  // ── Build trajectories ──
  //
  // Start with hot-module paths, then add top-level source dirs until
  // we hit MAX_TRAJECTORIES. Keep them in insertion order so the hot
  // modules surface first in the prompt.
  const trajectoryKeys: Array<{ path: string; isHotModule: boolean }> = [];
  const seenKeys = new Set<string>();
  for (const hm of hotModulePaths) {
    if (!hm || seenKeys.has(hm)) continue;
    seenKeys.add(hm);
    trajectoryKeys.push({ path: hm, isHotModule: true });
    if (trajectoryKeys.length >= MAX_TRAJECTORIES) break;
  }
  if (trajectoryKeys.length < MAX_TRAJECTORIES) {
    const topDirs = listTopLevelSourceDirs(repoDir);
    for (const td of topDirs) {
      if (seenKeys.has(td)) continue;
      seenKeys.add(td);
      trajectoryKeys.push({ path: td, isHotModule: false });
      if (trajectoryKeys.length >= MAX_TRAJECTORIES) break;
    }
  }

  const trajectories: ModuleTrajectory[] = trajectoryKeys.map(({ path, isHotModule }) => ({
    path,
    isHotModule,
    commitCount: 0,
    firstChange: '',
    lastChange: '',
    recentSubjects: [],
    conventionalTypes: {},
  }));

  // Fold commits into trajectories. A commit "touches" a trajectory
  // when any of its files starts with the trajectory path. For hot
  // modules we match exact path; for top-level dirs we match prefix.
  for (const c of commits) {
    const touched = new Set<number>();
    for (const f of c.files) {
      for (let i = 0; i < trajectories.length; i++) {
        const t = trajectories[i];
        if (touched.has(i)) continue;
        if (t.isHotModule) {
          if (f === t.path) touched.add(i);
        } else {
          if (f === t.path || f.startsWith(t.path + '/')) touched.add(i);
        }
      }
    }
    for (const idx of touched) {
      const t = trajectories[idx];
      t.commitCount++;
      if (!t.firstChange || c.date < t.firstChange) t.firstChange = c.date;
      if (!t.lastChange || c.date > t.lastChange) t.lastChange = c.date;
      if (
        t.recentSubjects.length < MAX_RECENT_SUBJECTS &&
        c.subject.length >= MIN_NON_TRIVIAL_SUBJECT_LEN
      ) {
        t.recentSubjects.push(c.subject);
      }
      const conv = extractConventionalType(c.subject);
      if (conv) {
        t.conventionalTypes[conv] = (t.conventionalTypes[conv] || 0) + 1;
      }
    }
  }

  // Drop trajectories with zero commits — they add nothing to the prompt.
  const nonEmptyTrajectories = trajectories.filter(t => t.commitCount > 0);

  // ── Build themes ──
  const themes = aggregateThemes(
    commits.map(c => ({ date: c.date, subject: c.subject }))
  );

  // ── Build incidents ──
  const incidents: RecentIncident[] = [];
  const incidentCutoff = new Date(Date.now() - INCIDENT_WINDOW_DAYS * 86_400_000);
  const cutoffStr = incidentCutoff.toISOString().slice(0, 10);
  for (const c of commits) {
    if (c.date < cutoffStr) continue;
    if (!INCIDENT_REGEX.test(c.subject)) continue;
    incidents.push({
      sha: c.sha,
      date: c.date,
      subject: c.subject,
      incidentMarkers: extractIncidentMarkers(c.subject),
      filesTouched: c.files.slice(0, MAX_FILES_PER_INCIDENT),
    });
    if (incidents.length >= MAX_INCIDENTS) break;
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    trajectories: nonEmptyTrajectories,
    themes,
    incidents,
    notes,
  };
}
