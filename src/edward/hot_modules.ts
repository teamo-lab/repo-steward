/**
 * HotModule detection — Layer 3 of the discover pipeline.
 *
 * Computes a per-file risk score from machine signals (git history,
 * coverage reports, optional complexity tools) and returns a ranked
 * top-N list of "files the LLM scan MUST deep-inspect this run".
 *
 * Why: the LLM scan in Phases 1-3 is non-deterministic — it picks
 * different feature subsets to explore on different runs, which means
 * a real bug in a high-churn file (e.g. payment scoring) might be
 * missed half the time. HotModules are computed deterministically
 * from non-LLM signals and injected into the prompt as a forcing
 * function: Phase 1.5 instructs the model to end-to-end trace every
 * file in this list before doing any free exploration.
 *
 * Three signal sources, all optional and gracefully degrading:
 *   1. git change frequency (last 30 days, requires --shallow-since
 *      clone — see cloneRepoWithToken in server.ts)
 *   2. test coverage report (lcov / coverage.xml / coverage.json,
 *      whichever is committed in the repo)
 *   3. cyclomatic complexity (radon for Python, fallback heuristic
 *      otherwise)
 *
 * If the repo has none of these (e.g. depth-1 fallback clone, no
 * coverage committed, no Python), detectHotModules returns an empty
 * list and Phase 1.5 becomes a no-op — the existing Phase 1-3 free
 * exploration still runs unchanged.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { execSync } from 'node:child_process';

// ── Public types ──

export interface HotModule {
  path: string;                // path relative to repoDir
  riskScore: number;            // unnormalized; sort by this
  reasons: string[];            // human-readable, embedded in prompt
  metrics: {
    changeFreq?: number;        // commits touching this file in last 30d
    coverage?: number;          // 0-1 (line-rate)
    complexity?: number;        // raw cyclomatic complexity total
    inversionScore?: number;    // changeFreq * (1 - coverage)
  };
}

// ── Source-file allowlist + exclusion ──

const SOURCE_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs',
  '.swift', '.scala', '.clj', '.ex', '.erl', '.elm',
  '.c', '.cc', '.cpp', '.h', '.hpp',
]);

const EXCLUDE_PATH_FRAGMENTS = [
  '/test/', '/tests/', '/__tests__/', '/spec/', '/specs/',
  '/test_', '_test.', '.test.', '.spec.',
  '/node_modules/', '/vendor/', '/third_party/', '/dist/',
  '/build/', '/.git/', '/docs/', '/examples/',
  '/migrations/', '/fixtures/',
];

function isSourceFile(path: string): boolean {
  if (!path) return false;
  const ext = extname(path).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return false;
  // Normalize to / for cross-platform fragment matching
  const normalized = '/' + path.replace(/\\/g, '/');
  for (const frag of EXCLUDE_PATH_FRAGMENTS) {
    if (normalized.includes(frag)) return false;
  }
  return true;
}

// ── Signal 1: git change frequency ──

/**
 * Returns commits-touching-file count for the last 30 days.
 *
 * Uses --no-merges so renames/merge bubbles don't inflate counts.
 * Uses --pretty=format: to get only the file lists; we then count
 * occurrences in shell-style (sort | uniq -c equivalent in JS).
 *
 * Returns empty object on any error (shallow clone with no history,
 * git not installed, etc.). Caller treats empty as "no signal".
 */
function computeChangeFrequency(repoDir: string): Record<string, number> {
  try {
    const out = execSync(
      'git log --no-merges --since="30 days ago" --pretty=format: --name-only',
      {
        cwd: repoDir,
        encoding: 'utf-8',
        maxBuffer: 100_000_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const counts: Record<string, number> = {};
    for (const line of out.split('\n')) {
      const path = line.trim();
      if (!path || !isSourceFile(path)) continue;
      counts[path] = (counts[path] || 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

// ── Signal 2: test coverage (best-effort, multiple formats) ──

/**
 * Try to find a coverage report committed in the repo and parse it
 * into a per-file line-rate map. Supports the most common formats:
 *
 *   - Cobertura XML (pytest-cov, coverage.py default, jest with cobertura reporter)
 *   - lcov.info (Istanbul / nyc / jest with lcov reporter, gcov)
 *   - coverage.json (coverage.py json export)
 *   - coverage-final.json (Jest's istanbul JSON)
 *
 * Returns empty if no recognized report found. We do NOT run tests
 * to generate coverage — Edward never executes target code.
 */
function detectCoverage(repoDir: string): Record<string, number> {
  // Candidate paths in priority order
  const candidates = [
    'coverage.xml',
    'coverage/coverage.xml',
    'coverage/cobertura-coverage.xml',
    'lcov.info',
    'coverage/lcov.info',
    'coverage/lcov-report/lcov.info',
    'coverage.json',
    'coverage/coverage-final.json',
    '.coverage.json',
  ];

  for (const rel of candidates) {
    const abs = join(repoDir, rel);
    if (!safeExists(abs)) continue;
    const text = safeReadText(abs, 50_000_000);
    if (!text) continue;

    if (rel.endsWith('.xml')) {
      const parsed = parseCoberturaXml(text);
      if (Object.keys(parsed).length > 0) return parsed;
    } else if (rel.endsWith('.info')) {
      const parsed = parseLcov(text);
      if (Object.keys(parsed).length > 0) return parsed;
    } else if (rel.endsWith('.json')) {
      const parsed = parseCoverageJson(text);
      if (Object.keys(parsed).length > 0) return parsed;
    }
  }
  return {};
}

/** Parse Cobertura XML — regex grab of <class filename="..." line-rate="..."> */
function parseCoberturaXml(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /<class\s+[^>]*filename="([^"]+)"[^>]*line-rate="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[2]) {
      const rate = parseFloat(m[2]);
      if (!isNaN(rate) && isSourceFile(m[1])) out[m[1]] = rate;
    }
  }
  return out;
}

/** Parse lcov.info — line-by-line, stateful per-file */
function parseLcov(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let currentFile: string | null = null;
  let linesFound = 0;
  let linesHit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3).trim();
      linesFound = 0;
      linesHit = 0;
    } else if (line.startsWith('LF:')) {
      linesFound = parseInt(line.slice(3).trim(), 10) || 0;
    } else if (line.startsWith('LH:')) {
      linesHit = parseInt(line.slice(3).trim(), 10) || 0;
    } else if (line.startsWith('end_of_record')) {
      if (currentFile && linesFound > 0 && isSourceFile(currentFile)) {
        out[currentFile] = linesHit / linesFound;
      }
      currentFile = null;
    }
  }
  return out;
}

/** Parse coverage.py JSON OR Istanbul coverage-final.json */
function parseCoverageJson(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return out; }
  if (!parsed || typeof parsed !== 'object') return out;

  // coverage.py shape: { files: { "src/foo.py": { summary: { percent_covered: 85 } } } }
  if (parsed.files && typeof parsed.files === 'object') {
    for (const [file, data] of Object.entries(parsed.files)) {
      const pct = (data as any)?.summary?.percent_covered;
      if (typeof pct === 'number' && isSourceFile(file)) {
        out[file] = pct / 100;
      }
    }
    if (Object.keys(out).length > 0) return out;
  }

  // Istanbul shape: { "src/foo.js": { s: { "0": 5, "1": 0, ... } } }
  for (const [file, data] of Object.entries(parsed)) {
    if (!isSourceFile(file)) continue;
    const s = (data as any)?.s;
    if (s && typeof s === 'object') {
      const counts = Object.values(s).map((v: any) => Number(v));
      const total = counts.length;
      if (total === 0) continue;
      const hit = counts.filter(c => c > 0).length;
      out[file] = hit / total;
    }
  }
  return out;
}

// ── Signal 3: complexity (optional, radon for python repos) ──

/**
 * Try to compute cyclomatic complexity per file using radon (Python).
 * Returns empty if radon isn't installed or fails — complexity is
 * the weakest of the three signals and graceful degradation is fine.
 *
 * For non-Python or radon-less environments, callers can fall back
 * to change_freq + coverage alone, which still flags the right files
 * for any actively-developed undertested module.
 */
function detectComplexity(repoDir: string): Record<string, number> {
  try {
    const out = execSync('radon cc -a -nc -j .', {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 50_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(out);
    if (!data || typeof data !== 'object') return {};
    const result: Record<string, number> = {};
    for (const [file, blocks] of Object.entries(data)) {
      if (!Array.isArray(blocks) || !isSourceFile(file)) continue;
      const total = (blocks as any[]).reduce(
        (s, b) => s + (typeof b?.complexity === 'number' ? b.complexity : 0),
        0
      );
      if (total > 0) result[file] = total;
    }
    return result;
  } catch {
    return {};
  }
}

// ── Safe file helpers (mirror profile.ts conventions) ──

function safeExists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

function safeReadText(path: string, maxBytes: number): string | null {
  try {
    const s = statSync(path);
    if (!s.isFile() || s.size > maxBytes) return null;
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

// ── Aggregation ──

/**
 * Aggregate all 3 signals into per-file riskScore.
 *
 * Scoring:
 *   inversion (change_freq × (1-coverage)) is the strongest signal —
 *   high churn + low coverage = where bugs slip through. Multiplied
 *   by 5 to dominate when present.
 *
 *   pure change frequency (no coverage data available) — multiplied
 *   by 2; still useful but weaker because we can't tell if it's well-
 *   tested high churn or not.
 *
 *   complexity adds 1× its raw value when ≥ 30 (the empirical "this
 *   function is hard to reason about" threshold from radon docs).
 *
 *   Files with no signal get score 0 and are filtered out.
 */
function scoreFile(
  path: string,
  changeFreq: number | undefined,
  coverage: number | undefined,
  complexity: number | undefined
): { score: number; reasons: string[]; metrics: HotModule['metrics'] } {
  const reasons: string[] = [];
  let score = 0;
  const metrics: HotModule['metrics'] = {};

  if (typeof changeFreq === 'number') metrics.changeFreq = changeFreq;
  if (typeof coverage === 'number') metrics.coverage = coverage;
  if (typeof complexity === 'number') metrics.complexity = complexity;

  // Inversion: high churn × low coverage
  if (typeof changeFreq === 'number' && typeof coverage === 'number') {
    const inv = changeFreq * (1 - coverage);
    metrics.inversionScore = inv;
    if (inv >= 3) {
      score += inv * 5;
      reasons.push(
        `${changeFreq} changes in 30d × ${Math.round(coverage * 100)}% coverage (inversion ${inv.toFixed(1)})`
      );
    }
  } else if (typeof changeFreq === 'number' && changeFreq >= 5) {
    // Pure change frequency (no coverage data) — weaker signal
    score += changeFreq * 2;
    reasons.push(`${changeFreq} changes in 30d (no coverage data available)`);
  }

  // Complexity adds when high
  if (typeof complexity === 'number' && complexity >= 30) {
    score += complexity;
    reasons.push(`cyclomatic complexity ${complexity}`);
  }

  return { score, reasons, metrics };
}

// ── Main entry ──

export function detectHotModules(
  repoDir: string,
  opts?: { topN?: number }
): HotModule[] {
  const topN = opts?.topN ?? 8;

  const changeFreq = computeChangeFrequency(repoDir);
  const coverage = detectCoverage(repoDir);
  const complexity = detectComplexity(repoDir);

  const allFiles = new Set<string>([
    ...Object.keys(changeFreq),
    ...Object.keys(coverage),
    ...Object.keys(complexity),
  ]);

  const modules: HotModule[] = [];
  for (const path of allFiles) {
    const { score, reasons, metrics } = scoreFile(
      path,
      changeFreq[path],
      coverage[path],
      complexity[path]
    );
    if (score > 0 && reasons.length > 0) {
      modules.push({ path, riskScore: score, reasons, metrics });
    }
  }

  modules.sort((a, b) => b.riskScore - a.riskScore);
  return modules.slice(0, topN);
}

