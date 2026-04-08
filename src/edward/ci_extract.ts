/**
 * CIRawConfig — extract CI configuration files from a target repo without
 * parsing them. Layer 2 of the CI completeness audit.
 *
 * Sprint 1 detects 7 CI providers by their config-file conventions but
 * only `github_actions` gets full multi-file extraction (the others ship
 * a single file or have wildly varying conventions). For non-github
 * providers we still record the config file path so Phase 0 prompt can
 * flag the platform mismatch.
 *
 * No YAML parsing in TypeScript — Edward shells out to intelligence.
 * The raw text is passed through to the `claude` subprocess which reads
 * it as part of Phase 0.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CIProvider =
  | 'github_actions'
  | 'gitlab_ci'
  | 'circleci'
  | 'jenkins'
  | 'azure_pipelines'
  | 'bitbucket_pipelines'
  | 'drone'
  | 'none';

export interface CIRawConfig {
  /**
   * The "primary" provider, picked by priority order when multiple
   * providers leave config files in the repo. Phase 0 prompt should
   * still inspect every entry in `configFiles` and flag any provider
   * mismatch.
   */
  provider: CIProvider;

  /**
   * Every CI config file we found, across all providers, with raw
   * content. Cap each file at 100KB to avoid blowing up the prompt.
   */
  configFiles: Array<{
    path: string;       // path relative to repoDir
    provider: CIProvider;
    content: string;
    sizeBytes: number;
    truncated: boolean;
  }>;

  /**
   * Deterministic coverage detection. Populated by scanning
   * `configFiles[].content` and repo root for well-known coverage
   * tools, actions, and reporter configs. The LLM no longer has to
   * guess whether a project "tracks coverage" — we tell it with a
   * high-signal boolean plus the exact matches for evidence.
   *
   * NOTE: `detected=true` only means coverage TOOLING is present in
   * CI or the repo. It does NOT mean coverage is good, enforced, or
   * trending up. Phase 0 prompt turns this into a coverage dimension
   * score with the LLM's help.
   */
  coverage: CoverageSignals;
}

/**
 * Deterministic coverage-tooling detection result. All three lists
 * can be empty; `detected` is the disjunction `collected || reported
 * || configured`.
 */
export interface CoverageSignals {
  /** True if any collected | reported | configured tool was found. */
  detected: boolean;

  /**
   * Tools that actually COLLECT coverage data inside a CI step, like
   * `pytest --cov`, `jest --coverage`, `go test -coverprofile`. These
   * are the "does the test run produce a coverage report at all"
   * signals.
   */
  collected: string[];

  /**
   * Services that UPLOAD/REPORT coverage to an external dashboard,
   * like `codecov/codecov-action`, `coverallsapp/github-action`.
   * These are the "is coverage visible to humans" signals.
   */
  reported: string[];

  /**
   * Project-level coverage CONFIG files at repo root, like
   * `codecov.yml`, `.coveragerc`, `.coveralls.yml`. These imply the
   * project has opinions about coverage targets / thresholds even if
   * the CI job invocation is elsewhere.
   */
  configured: string[];
}

const MAX_FILE_BYTES = 100_000;

// Single-file providers, in priority order
const SINGLE_FILE_PROVIDERS: Array<{ provider: CIProvider; relPath: string }> = [
  { provider: 'gitlab_ci',           relPath: '.gitlab-ci.yml' },
  { provider: 'circleci',            relPath: '.circleci/config.yml' },
  { provider: 'jenkins',             relPath: 'Jenkinsfile' },
  { provider: 'azure_pipelines',     relPath: 'azure-pipelines.yml' },
  { provider: 'bitbucket_pipelines', relPath: 'bitbucket-pipelines.yml' },
  { provider: 'drone',               relPath: '.drone.yml' },
];

function safeReadFile(absPath: string): { content: string; sizeBytes: number; truncated: boolean } | null {
  try {
    const s = statSync(absPath);
    if (!s.isFile()) return null;
    const sizeBytes = s.size;
    const truncated = sizeBytes > MAX_FILE_BYTES;
    const content = truncated
      ? readFileSync(absPath, 'utf-8').slice(0, MAX_FILE_BYTES)
      : readFileSync(absPath, 'utf-8');
    return { content, sizeBytes, truncated };
  } catch {
    return null;
  }
}

function safeListDir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function safeExists(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

export function extractCIRawConfig(repoDir: string): CIRawConfig {
  const configFiles: CIRawConfig['configFiles'] = [];
  let primary: CIProvider = 'none';

  // GitHub Actions: .github/workflows/*.{yml,yaml}
  const ghWorkflowsDir = join(repoDir, '.github', 'workflows');
  if (safeExists(ghWorkflowsDir)) {
    const entries = safeListDir(ghWorkflowsDir);
    let foundAny = false;
    for (const entry of entries) {
      if (!/\.(ya?ml)$/i.test(entry)) continue;
      const absPath = join(ghWorkflowsDir, entry);
      const file = safeReadFile(absPath);
      if (!file) continue;
      configFiles.push({
        path: `.github/workflows/${entry}`,
        provider: 'github_actions',
        content: file.content,
        sizeBytes: file.sizeBytes,
        truncated: file.truncated,
      });
      foundAny = true;
    }
    if (foundAny) primary = 'github_actions';
  }

  // Single-file providers
  for (const { provider, relPath } of SINGLE_FILE_PROVIDERS) {
    const absPath = join(repoDir, relPath);
    if (!safeExists(absPath)) continue;
    const file = safeReadFile(absPath);
    if (!file) continue;
    configFiles.push({
      path: relPath,
      provider,
      content: file.content,
      sizeBytes: file.sizeBytes,
      truncated: file.truncated,
    });
    if (primary === 'none') primary = provider;
  }

  const coverage = detectCoverageSignals(repoDir, configFiles);
  return { provider: primary, configFiles, coverage };
}

// ── Coverage detection ──

/**
 * Patterns we look for inside workflow-file CONTENT to detect
 * coverage collection (tests that produce reports) and reporting
 * (steps that upload to an external service).
 *
 * Patterns are case-insensitive and checked as plain substrings or
 * simple regexes. We deliberately avoid YAML parsing — the goal is
 * a zero-dependency high-recall scan, not a perfect structural
 * match. False positives are fine if the string appears in a comment
 * or README fragment; Phase 0 LLM can disambiguate.
 */
const COLLECTOR_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // Python
  { label: 'pytest --cov',         pattern: /pytest[^\n]*--cov\b/i },
  { label: 'coverage run',         pattern: /\bcoverage\s+run\b/i },
  { label: 'coverage.py',          pattern: /\bcoverage\s+(xml|report|html|json)\b/i },
  { label: 'pytest-cov',           pattern: /pytest-cov/i },
  // JavaScript / TypeScript
  { label: 'jest --coverage',      pattern: /\bjest\b[^\n]*--coverage\b/i },
  { label: 'vitest --coverage',    pattern: /\bvitest\b[^\n]*--coverage\b/i },
  { label: 'c8',                   pattern: /\bc8\s+(node|npm|pnpm|yarn|--)/i },
  { label: 'nyc',                  pattern: /\bnyc\s+(node|npm|pnpm|yarn|--|mocha)/i },
  // Go
  { label: 'go test -cover',       pattern: /go\s+test\b[^\n]*-cover(profile)?\b/i },
  { label: 'gocovmerge',           pattern: /gocovmerge/i },
  // Rust
  { label: 'cargo llvm-cov',       pattern: /cargo\s+llvm-cov/i },
  { label: 'cargo tarpaulin',      pattern: /cargo\s+tarpaulin/i },
  // Java / Kotlin
  { label: 'jacoco',               pattern: /jacoco/i },
  // .NET
  { label: 'dotnet test coverage', pattern: /dotnet\s+test[^\n]*(collect:?["']?XPlat Code Coverage|--coverage)/i },
  // Ruby
  { label: 'simplecov',            pattern: /simplecov/i },
  // PHP
  { label: 'phpunit --coverage',   pattern: /phpunit[^\n]*--coverage-/i },
  // Generic
  { label: 'lcov',                 pattern: /\blcov\b/i },
];

const REPORTER_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'codecov/codecov-action',          pattern: /\bcodecov\/codecov-action\b/i },
  { label: 'codecov cli',                     pattern: /\bbash\s+<\(curl.*codecov\.io/i },
  { label: 'coverallsapp/github-action',      pattern: /\bcoverallsapp\/github-action\b/i },
  { label: 'paambaati/codeclimate-action',    pattern: /\bpaambaati\/codeclimate-action\b/i },
  { label: 'SonarSource/sonarcloud-github-action', pattern: /\bsonarsource\/sonarcloud-github-action\b/i },
  { label: 'sonarqube-scan-action',           pattern: /\bsonarsource\/sonarqube-scan-action\b/i },
  { label: 'actions-rs/tarpaulin',            pattern: /\bactions-rs\/tarpaulin\b/i },
];

// Project-level coverage config files at repo root. Presence of any
// of these strongly suggests the team has opinions about coverage
// (thresholds, ignore paths, targets) even if the CI invocation
// happens via Makefile or shell script that we can't fully parse.
const COVERAGE_CONFIG_FILES = [
  'codecov.yml',
  '.codecov.yml',
  '.coveragerc',
  '.coveralls.yml',
  'coverage.ini',
];

function detectCoverageSignals(
  repoDir: string,
  configFiles: CIRawConfig['configFiles']
): CoverageSignals {
  const collected = new Set<string>();
  const reported = new Set<string>();
  const configured: string[] = [];

  // Scan CI file content
  for (const f of configFiles) {
    for (const { label, pattern } of COLLECTOR_PATTERNS) {
      if (pattern.test(f.content)) collected.add(label);
    }
    for (const { label, pattern } of REPORTER_PATTERNS) {
      if (pattern.test(f.content)) reported.add(label);
    }
  }

  // Scan repo root for coverage config files
  for (const name of COVERAGE_CONFIG_FILES) {
    if (safeExists(join(repoDir, name))) {
      configured.push(name);
    }
  }

  // pyproject.toml / setup.cfg: quickly check for a [tool.coverage]
  // or [coverage:*] section. We don't parse TOML/INI, just substring.
  for (const cfgFile of ['pyproject.toml', 'setup.cfg']) {
    const abs = join(repoDir, cfgFile);
    if (!safeExists(abs)) continue;
    try {
      const content = readFileSync(abs, 'utf-8').slice(0, 50_000);
      if (/\[tool\.coverage/i.test(content) || /\[coverage:/i.test(content)) {
        configured.push(cfgFile);
      }
    } catch { /* best-effort */ }
  }

  const collectedArr = [...collected];
  const reportedArr = [...reported];
  const detected = collectedArr.length > 0 || reportedArr.length > 0 || configured.length > 0;

  return {
    detected,
    collected: collectedArr,
    reported: reportedArr,
    configured,
  };
}

