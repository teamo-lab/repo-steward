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
import { computeCICoverage, type CICoverageResult } from './ci_coverage.js';

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
   * Deterministic line-level coverage analysis. Computed by walking
   * the source tree, extracting path prefixes from verifying CI
   * steps (test / lint / typecheck / security-scan / grep invariants /
   * script execution), and summing LOC over files that match at least
   * one prefix.
   *
   * This is NOT traditional runtime test-line-rate. It's the static
   * reachability question "which source code is in scope of any CI
   * verification step", weighted by file LOC. Implementation in
   * ci_coverage.ts.
   */
  coverage: CICoverageResult;
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

  const coverage = computeCICoverage(repoDir, configFiles);
  return { provider: primary, configFiles, coverage };
}

