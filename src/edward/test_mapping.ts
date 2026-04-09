/**
 * Test Mapping — find which features have existing test coverage by
 * scanning the project's test directories. Deterministic, no LLM.
 *
 * The mapping is deliberately fuzzy:
 *
 *   - A feature is "covered" if we can locate at least one test file
 *     whose contents plausibly exercise it (mentions the file/path/
 *     handler/label)
 *   - "Plausibly" is substring or normalized-path match against the
 *     test file content
 *   - A test file is anything under a tests/test/spec dir, or with a
 *     `test_*` / `*_test` / `*.test.*` / `*.spec.*` basename, or with
 *     `#[test]` / `@Test` attributes inside the file
 *
 * This is the input to the invariant-coverage LLM call: instead of
 * asking "is invariant X tested?" with no context, we ask "is
 * invariant X tested? Here are the tests that mention the feature
 * it belongs to".
 *
 * Fully language-agnostic. No project-specific assumptions.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Feature, FeatureSurface, FeatureKind } from './feature_inventory.js';

// ── Public types ──

export interface TestFile {
  /** repo-relative path */
  path: string;
  /** Language extension ("py", "ts", etc.) */
  ext: string;
  /** 1-4 sampled test function names extracted from the file. */
  sampled_tests: string[];
  /** Raw line count (informational). */
  loc: number;
}

export interface FeatureCoverage {
  feature: Feature;
  /** Test files that mention this feature's file path / handler / label. */
  covering_test_files: Array<{
    path: string;
    reason: 'path_match' | 'label_match' | 'handler_match' | 'nearby_dir';
  }>;
  /** Human summary of coverage strength: none / thin / covered. */
  strength: 'none' | 'thin' | 'covered';
}

export interface TestCoverageMap {
  /** All test files discovered in the repo. */
  test_files: TestFile[];
  /** Per-feature coverage annotations. */
  features: FeatureCoverage[];
  /** Quick rollup. */
  summary: {
    total_features: number;
    features_with_any_test: number;
    features_with_no_test: number;
  };
}

// ── Config ──

const TEST_DIR_NAMES = new Set([
  'tests', 'test', '__tests__', 'spec', 'specs', 'test_e2e', 'e2e',
  'integration_tests', 'it', 'unit_tests', 'functional_tests',
  'features', // cucumber/behave
]);

const TEST_EXT_MATCHERS: Array<{ ext: string; re: RegExp }> = [
  { ext: 'py', re: /^test_[\w-]+\.py$|_test\.py$/ },
  { ext: 'ts', re: /\.(test|spec)\.(ts|tsx|mts|cts)$/ },
  { ext: 'js', re: /\.(test|spec)\.(js|jsx|mjs|cjs)$/ },
  { ext: 'go', re: /_test\.go$/ },
  { ext: 'rs', re: /tests?\/.+\.rs$/ }, // rust often has tests in tests/ dir
  { ext: 'java', re: /(Test|Tests|IT|ITCase)\.java$/ },
  { ext: 'kt', re: /(Test|Tests)\.kt$/ },
  { ext: 'rb', re: /_spec\.rb$|_test\.rb$/ },
  { ext: 'php', re: /Test\.php$/ },
  { ext: 'cs', re: /(Test|Tests)\.cs$/ },
];

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'out',
  '__pycache__', '.venv', 'venv', 'env',
  '.next', '.nuxt', '.cache', '.idea', '.vscode',
  'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
]);

// ── Test file discovery ──

/**
 * Walk the repo and return every file that looks like a test file by
 * (a) living under a test directory, or (b) matching a
 * per-language test basename regex. Extracts the first few test
 * function names from each file for downstream matching.
 */
export function discoverTestFiles(repoDir: string): TestFile[] {
  const out: TestFile[] = [];

  const walk = (abs: string, rel: string, inTestDir: boolean) => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }
    for (const name of entries) {
      if (IGNORE_DIRS.has(name)) continue;
      if (name.startsWith('.') && name !== '.github') continue;
      const full = join(abs, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      const relPath = rel ? `${rel}/${name}` : name;
      if (s.isDirectory()) {
        const childInTestDir = inTestDir || TEST_DIR_NAMES.has(name);
        walk(full, relPath, childInTestDir);
        continue;
      }
      if (!s.isFile()) continue;
      if (s.size > 500_000) continue;

      const bn = basename(name);
      const ext = bn.includes('.') ? bn.split('.').pop()!.toLowerCase() : '';
      const isTestByName = TEST_EXT_MATCHERS.some(
        (r) => r.ext === ext && r.re.test(bn)
      );
      // In test dir AND it's a source-ish file → also treat as test file
      const isTestByLocation = inTestDir &&
        ['py', 'ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs'].includes(ext);

      if (!isTestByName && !isTestByLocation) continue;

      try {
        const content = readFileSync(full, 'utf-8');
        if (content.indexOf('\0') !== -1) continue;
        out.push({
          path: relPath,
          ext,
          sampled_tests: sampleTestFunctions(content, ext),
          loc: content.split('\n').length,
        });
      } catch { continue; }
    }
  };

  walk(repoDir, '', false);
  return out;
}

/**
 * Extract up to 6 test function / describe / it names from a test
 * file's content. Used to give the LLM hints when asking "which test
 * covers which invariant".
 */
function sampleTestFunctions(content: string, ext: string): string[] {
  const out: string[] = [];
  const push = (n: string) => {
    if (n && !out.includes(n)) out.push(n);
  };

  // Language-specific patterns
  if (ext === 'py') {
    for (const m of content.matchAll(/^\s*def\s+(test_\w+)\s*\(/gm)) push(m[1]);
    for (const m of content.matchAll(/^\s*async\s+def\s+(test_\w+)\s*\(/gm)) push(m[1]);
    for (const m of content.matchAll(/^\s*class\s+(Test\w+)\s*[(:]/gm)) push(m[1]);
  } else if (['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)) {
    for (const m of content.matchAll(/\b(?:test|it|describe)\s*\(\s*["']([^"']+)["']/g)) push(m[1]);
  } else if (ext === 'go') {
    for (const m of content.matchAll(/^func\s+(Test\w+)\s*\(/gm)) push(m[1]);
  } else if (ext === 'rs') {
    for (const m of content.matchAll(/^\s*#\[test\][\s\n]+\s*fn\s+(\w+)/gm)) push(m[1]);
  } else if (ext === 'java' || ext === 'kt') {
    for (const m of content.matchAll(/@Test[^\n]*\s+(?:public|fun)\s+(?:\w+\s+)?(\w+)\s*\(/g)) push(m[1]);
  } else if (ext === 'rb') {
    for (const m of content.matchAll(/\b(?:it|describe)\s+["']([^"']+)["']/g)) push(m[1]);
    for (const m of content.matchAll(/\bdef\s+(test_\w+)/g)) push(m[1]);
  } else if (ext === 'php') {
    for (const m of content.matchAll(/public\s+function\s+(test\w+)\s*\(/g)) push(m[1]);
  } else if (ext === 'cs') {
    for (const m of content.matchAll(/\[(Test|Fact|Theory)\][^\n]*\s+public\s+(?:async\s+)?[A-Za-z<>]*\s+(\w+)\s*\(/g)) push(m[2]);
  }

  return out.slice(0, 6);
}

// ── Feature → test mapping ──

/**
 * For each feature in the FeatureSurface, find test files that
 * plausibly exercise it. "Plausibly" = test file content mentions the
 * feature's file path, label (e.g. `POST /chat`), or handler name.
 *
 * Returns a FeatureCoverage entry for every feature, including those
 * with no covering tests — downstream needs to know both sides.
 */
export function mapFeaturesToTests(
  repoDir: string,
  features: FeatureSurface
): TestCoverageMap {
  const testFiles = discoverTestFiles(repoDir);

  // Preload test file content for matching
  const contents: Array<{ tf: TestFile; content: string; contentLower: string }> = [];
  for (const tf of testFiles) {
    try {
      const content = readFileSync(join(repoDir, tf.path), 'utf-8');
      contents.push({ tf, content, contentLower: content.toLowerCase() });
    } catch { /* ignore */ }
  }

  const allFeatures: Feature[] = [
    ...features.endpoints,
    ...features.llm_calls,
    ...features.cron_jobs,
    ...features.queue_consumers,
  ];

  const coverages: FeatureCoverage[] = [];
  let withAny = 0;

  for (const feature of allFeatures) {
    const hits: FeatureCoverage['covering_test_files'] = [];

    for (const { tf, content, contentLower } of contents) {
      const reason = matchFeatureInContent(feature, content, contentLower, tf);
      if (reason) hits.push({ path: tf.path, reason });
    }

    let strength: FeatureCoverage['strength'] = 'none';
    if (hits.length >= 2) strength = 'covered';
    else if (hits.length === 1) strength = 'thin';

    if (hits.length > 0) withAny++;
    coverages.push({ feature, covering_test_files: hits, strength });
  }

  return {
    test_files: testFiles,
    features: coverages,
    summary: {
      total_features: allFeatures.length,
      features_with_any_test: withAny,
      features_with_no_test: allFeatures.length - withAny,
    },
  };
}

/**
 * Heuristic: does this test file reference this feature? Checks in order:
 *
 *   1. Test file includes the feature's source file path
 *      (stripped of extension)
 *   2. Test file includes the feature's label (e.g. "POST /chat")
 *   3. Test file includes the handler name from meta
 *   4. Test file lives in a test dir whose name mirrors the feature's
 *      source dir
 */
function matchFeatureInContent(
  feature: Feature,
  content: string,
  contentLower: string,
  tf: TestFile
): FeatureCoverage['covering_test_files'][number]['reason'] | null {
  // 1. Direct path reference (normalized)
  const srcNoExt = feature.file.replace(/\.(py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rs|java|kt|rb|php|cs)$/i, '');
  const srcBase = srcNoExt.replace(/^.*\//, ''); // basename without extension
  if (contentLower.includes(srcNoExt.toLowerCase())) {
    return 'path_match';
  }
  if (srcBase.length >= 4 && contentLower.includes(srcBase.toLowerCase())) {
    return 'path_match';
  }

  // 2. Label match — for HTTP endpoints the label is `METHOD /path`,
  //    but the test may only mention `/path`. Extract the path portion
  //    and substring-match.
  if (feature.meta.path) {
    const p = feature.meta.path.replace(/\{([^}]+)\}/g, '$1'); // {id} → id
    if (p.length >= 4 && content.includes(p)) return 'label_match';
  } else if (feature.label.length >= 4 && content.includes(feature.label)) {
    return 'label_match';
  }

  // 3. Handler name
  if (feature.meta.handler && feature.meta.handler.length >= 4 &&
      contentLower.includes(feature.meta.handler.toLowerCase())) {
    return 'handler_match';
  }

  // 4. Nearby dir — test file's dir matches feature's dir
  const srcTop = feature.file.split('/').slice(0, -1).join('/');
  const tfTop = tf.path.split('/').slice(0, -1).join('/');
  if (srcTop && tfTop && tfTop.toLowerCase().includes(srcTop.toLowerCase().split('/').slice(-1)[0])) {
    return 'nearby_dir';
  }

  return null;
}

// ── Test style sampling ──

/**
 * Sample a handful of real test files to use as style reference for
 * the Test Synthesis LLM call. Returns at most `n` files, biased
 * toward the language matching `preferredExt` (so test generation
 * matches project conventions).
 */
export function sampleTestStyleReference(
  repoDir: string,
  testFiles: TestFile[],
  opts?: { n?: number; preferredExt?: string; maxBytesPerFile?: number }
): Array<{ path: string; content: string }> {
  const n = opts?.n ?? 3;
  const preferredExt = opts?.preferredExt;
  const maxBytes = opts?.maxBytesPerFile ?? 8_000;

  // Rank: preferred ext first, then by number of sampled tests (likely richer)
  const ranked = [...testFiles].sort((a, b) => {
    const aPref = preferredExt && a.ext === preferredExt ? 0 : 1;
    const bPref = preferredExt && b.ext === preferredExt ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    return b.sampled_tests.length - a.sampled_tests.length;
  });

  const out: Array<{ path: string; content: string }> = [];
  for (const tf of ranked) {
    if (out.length >= n) break;
    try {
      const abs = join(repoDir, tf.path);
      const content = readFileSync(abs, 'utf-8').slice(0, maxBytes);
      if (content.indexOf('\0') !== -1) continue;
      out.push({ path: tf.path, content });
    } catch { /* ignore */ }
  }
  return out;
}

// ── Summary helpers for prompts ──

/**
 * Compact representation of TestCoverageMap for embedding in LLM
 * prompts. Groups by feature kind and omits fully-covered features
 * to keep the prompt focused on gaps.
 */
export function coverageForPrompt(
  map: TestCoverageMap,
  opts?: { maxPerKind?: number; includeCovered?: boolean }
): any {
  const cap = opts?.maxPerKind ?? 30;
  const includeCovered = opts?.includeCovered ?? false;

  const byKind: Record<FeatureKind, Array<any>> = {
    http_endpoint: [],
    llm_call: [],
    cron_job: [],
    queue_consumer: [],
  };

  for (const c of map.features) {
    if (!includeCovered && c.strength === 'covered') continue;
    byKind[c.feature.kind].push({
      id: c.feature.id,
      label: c.feature.label,
      file: c.feature.file,
      line: c.feature.line,
      framework: c.feature.framework,
      language: c.feature.language,
      strength: c.strength,
      covering: c.covering_test_files.map((t) => t.path),
    });
  }

  for (const k of Object.keys(byKind) as FeatureKind[]) {
    byKind[k] = byKind[k].slice(0, cap);
  }

  return {
    summary: map.summary,
    test_files: map.test_files.map((t) => ({
      path: t.path,
      tests_sampled: t.sampled_tests,
    })).slice(0, 20),
    by_kind: byKind,
  };
}
