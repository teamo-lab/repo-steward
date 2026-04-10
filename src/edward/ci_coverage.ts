/**
 * CI line-level coverage — computes what fraction of a repo's source
 * code (measured in LOC) is reachable by any "verifying" CI step.
 *
 * Definition (strict mode):
 *
 *   coverage_ratio = covered_loc / total_loc
 *
 * Where:
 *   - total_loc   = Σ lineCount(f) for every source file under an
 *                   extension allowlist, excluding ignored directories
 *   - covered_loc = Σ lineCount(f) for every source file whose
 *                   repo-relative path is prefixed by at least one
 *                   path emitted by a "verifying" CI step
 *
 * "Verifying" steps are static-analysis, test, typecheck, lint, format,
 * security-scan, or direct script execution invocations. A `docker
 * build .` that only copies source into an image without executing it
 * does NOT verify; a `RUN pytest` inside Dockerfile would (not yet
 * parsed).
 *
 * Reachability is file-level binary (covered or not), but the contribution
 * is weighted by LOC. A 10,000-line dead module weighs 10,000 lines
 * against the denominator, not 1 file.
 *
 * No YAML parsing — we pattern-match against raw workflow content, which
 * is high-recall, zero-dep, and stable across CI providers. False
 * positives (a path mentioned in a comment) are fine; they make the
 * numerator more generous, which is the correct direction when in doubt.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Public types ──

export interface SourceFile {
  /** repo-relative path, forward-slash separated */
  path: string;
  /** file extension (lowercase, no dot). 'dockerfile' / 'makefile' for special basenames. */
  ext: string;
  /** First path segment, '.' for root files. */
  topDir: string;
  /** Raw line count (split on \n, includes blanks and comments). */
  loc: number;
}

export interface CICoverageResult {
  // Core metric
  covered_loc: number;
  total_loc: number;
  coverage_ratio: number;  // 0..1

  // Counts
  total_files: number;
  covered_files: number;

  // The path prefixes Edward extracted from CI. Present so the LLM can
  // see exactly which parts of the repo CI touches, and surface them
  // in scorecard evidence.
  covered_paths: string[];

  // Bucketed breakdowns for evidence / gap writeups.
  by_extension: Record<string, { covered_loc: number; total_loc: number }>;
  by_top_dir:   Record<string, { covered_loc: number; total_loc: number }>;

  // Largest uncovered nested dirs (up to second level). These become
  // scorecard `gaps` entries directly.
  top_uncovered_dirs: Array<{ dir: string; loc: number }>;

  // Set when coverage could not be computed normally. Phase 0 scorecard
  // should treat any non-empty fallback as coverage=0, fail.
  fallback_reason?: 'no_ci' | 'no_verifying_steps_detected' | 'no_source_files';
}

// ── Source file enumeration ──

const SOURCE_EXTENSIONS = new Set([
  'py', 'pyi',
  'ts', 'tsx', 'mts', 'cts',
  'js', 'jsx', 'mjs', 'cjs',
  'go',
  'rs',
  'java', 'kt', 'kts', 'scala',
  'rb',
  'php',
  'cs', 'vb', 'fs',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
  'swift', 'm', 'mm',
  'dart',
  'lua',
  'sh', 'bash', 'zsh',
  'tf', 'tfvars',
]);

const SPECIAL_BASENAMES: Record<string, string> = {
  Makefile: 'makefile',
  Rakefile: 'rakefile',
  Gemfile: 'gemfile',
};

function isDockerfile(name: string): boolean {
  return name === 'Dockerfile' || name.startsWith('Dockerfile.');
}

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'out',
  '__pycache__', '.venv', 'venv', 'env', 'envs',
  '.next', '.nuxt', '.cache',
  '.idea', '.vscode', '.vs',
  'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.gradle', '.m2', '.yarn', '.pnp',
]);

/**
 * Recursively list source files in `repoDir` with line counts. Returns
 * repo-relative paths. Skips ignored directories, binaries (files
 * containing a null byte), and files above 2MB.
 */
export function enumerateSourceFiles(repoDir: string): SourceFile[] {
  const results: SourceFile[] = [];

  const walk = (abs: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }
    for (const name of entries) {
      if (IGNORE_DIRS.has(name)) continue;
      // Hidden directories skipped, except .github (CI lives there)
      if (name.startsWith('.') && name !== '.github') continue;
      const full = join(abs, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!st.isFile()) continue;

      const dotIdx = name.lastIndexOf('.');
      const ext = dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : '';

      let finalExt: string;
      if (SOURCE_EXTENSIONS.has(ext)) {
        finalExt = ext;
      } else if (SPECIAL_BASENAMES[name]) {
        finalExt = SPECIAL_BASENAMES[name];
      } else if (isDockerfile(name)) {
        finalExt = 'dockerfile';
      } else {
        continue;
      }

      // Cap per-file size at 2MB to avoid stalling on generated files
      if (st.size > 2 * 1024 * 1024) continue;

      let loc: number;
      try {
        const content = readFileSync(full, 'utf-8');
        if (content.indexOf('\0') !== -1) continue; // binary
        loc = content.split('\n').length;
      } catch { continue; }
      if (loc === 0) continue;

      const topDir = relPath.includes('/') ? relPath.split('/')[0] : '.';
      results.push({ path: relPath, ext: finalExt, topDir, loc });
    }
  };

  walk(repoDir, '');
  return results;
}

// ── Tool matchers ──

interface ToolMatcher {
  /** Canonical name, matched as the leading word(s) in the command. */
  name: string;
  /** Word-boundary regex to quickly filter candidate lines. */
  pattern: RegExp;
  /** Default path(s) when the tool is invoked with no positional args. */
  defaults: string[];
  /** Flags that consume the following token as their argument (not a path). */
  flagsWithArg?: Set<string>;
  /** For grep and similar: skip the first positional arg (the pattern). */
  skipFirstArg?: boolean;
  /** For grep: use only the LAST positional arg as the path. */
  lastOnly?: boolean;
}

const TOOL_MATCHERS: ToolMatcher[] = [
  // Python — test/lint/typecheck
  {
    name: 'pytest',
    pattern: /(?:^|[\s;&|])pytest\b/,
    defaults: ['.'],
    flagsWithArg: new Set([
      '-m', '-k', '--markers', '--ignore', '--ignore-glob', '--rootdir',
      '-c', '--config-file', '-o', '--override-ini', '-p', '--plugin',
      '--junitxml', '--junit-xml', '--log-file', '--deselect',
      '--confcutdir', '--junit-prefix',
    ]),
  },
  { name: 'coverage run', pattern: /\bcoverage\s+run\b/, defaults: ['.'], flagsWithArg: new Set(['--source', '--rcfile', '--include', '--omit']) },
  { name: 'ruff check',   pattern: /\bruff\s+check\b/,   defaults: ['.'] },
  { name: 'ruff format',  pattern: /\bruff\s+format\b/,  defaults: ['.'] },
  { name: 'ruff',         pattern: /\bruff(?!\s+(check|format))\b/, defaults: ['.'] },
  { name: 'flake8',       pattern: /\bflake8\b/,         defaults: ['.'], flagsWithArg: new Set(['--config']) },
  { name: 'mypy',         pattern: /\bmypy\b/,           defaults: ['.'], flagsWithArg: new Set(['--config-file', '-p', '--package']) },
  { name: 'pylint',       pattern: /\bpylint\b/,         defaults: [],    flagsWithArg: new Set(['--rcfile', '--load-plugins']) },
  { name: 'black',        pattern: /\bblack\b/,          defaults: ['.'], flagsWithArg: new Set(['--config']) },
  { name: 'isort',        pattern: /\bisort\b/,          defaults: ['.'] },
  { name: 'bandit',       pattern: /\bbandit\b/,         defaults: ['.'], flagsWithArg: new Set(['-c', '-ll', '--configfile']) },

  // JavaScript/TypeScript
  { name: 'jest',         pattern: /\bjest\b/,           defaults: ['.'], flagsWithArg: new Set(['--config', '--testPathPattern', '--testPathIgnorePatterns', '--roots']) },
  { name: 'vitest',       pattern: /\bvitest\b/,         defaults: ['.'], flagsWithArg: new Set(['--config']) },
  { name: 'eslint',       pattern: /\beslint\b/,         defaults: ['.'], flagsWithArg: new Set(['--config', '--ext', '--resolve-plugins-relative-to']) },
  { name: 'tsc',          pattern: /(?:^|[\s;&|])tsc\b/, defaults: ['.'], flagsWithArg: new Set(['-p', '--project']) },
  { name: 'prettier',     pattern: /\bprettier\b/,       defaults: ['.'], flagsWithArg: new Set(['--config']) },
  { name: 'biome check',  pattern: /\bbiome\s+(check|ci|lint|format)\b/, defaults: ['.'] },

  // Go
  { name: 'go test',      pattern: /\bgo\s+test\b/,      defaults: ['.'] },
  { name: 'go vet',       pattern: /\bgo\s+vet\b/,       defaults: ['.'] },
  { name: 'go build',     pattern: /\bgo\s+build\b/,     defaults: ['.'] },
  { name: 'golangci-lint run', pattern: /\bgolangci-lint\s+run\b/, defaults: ['.'] },

  // Rust
  { name: 'cargo test',   pattern: /\bcargo\s+test\b/,   defaults: ['.'] },
  { name: 'cargo clippy', pattern: /\bcargo\s+clippy\b/, defaults: ['.'] },
  { name: 'cargo check',  pattern: /\bcargo\s+check\b/,  defaults: ['.'] },
  { name: 'cargo build',  pattern: /\bcargo\s+build\b/,  defaults: ['.'] },

  // JVM
  { name: 'mvn',          pattern: /\bmvn\s+(\w+\s+)*(test|verify|install)\b/, defaults: ['.'] },
  { name: 'gradle',       pattern: /\bgradlew?\s+\w*(test|check|build)\b/, defaults: ['.'] },

  // Ruby
  { name: 'rspec',        pattern: /\brspec\b/,          defaults: ['spec'] },
  { name: 'rubocop',      pattern: /\brubocop\b/,        defaults: ['.'] },

  // PHP
  { name: 'phpunit',      pattern: /\bphpunit\b/,        defaults: ['.'], flagsWithArg: new Set(['--configuration', '-c']) },
  { name: 'phpstan analyse', pattern: /\bphpstan\s+analy[sz]e\b/, defaults: ['.'] },
  { name: 'psalm',        pattern: /\bpsalm\b/,          defaults: ['.'] },

  // .NET
  { name: 'dotnet test',  pattern: /\bdotnet\s+test\b/,  defaults: ['.'] },
  { name: 'dotnet build', pattern: /\bdotnet\s+build\b/, defaults: ['.'] },

  // Shell
  { name: 'shellcheck',   pattern: /\bshellcheck\b/,     defaults: [] },
  { name: 'shfmt',        pattern: /\bshfmt\b/,          defaults: ['.'] },

  // Terraform
  { name: 'terraform validate', pattern: /\bterraform\s+validate\b/, defaults: ['.'] },
  { name: 'terraform fmt',      pattern: /\bterraform\s+fmt\b/,      defaults: ['.'], flagsWithArg: new Set(['-chdir']) },
  { name: 'tflint',       pattern: /\btflint\b/,         defaults: ['.'] },
  { name: 'tfsec',        pattern: /\btfsec\b/,          defaults: ['.'] },
  { name: 'checkov',      pattern: /\bcheckov\b/,        defaults: ['.'], flagsWithArg: new Set(['-d', '--directory', '-f', '--file']) },

  // Docker
  { name: 'hadolint',     pattern: /\bhadolint\b/,       defaults: [] },

  // GitHub Actions
  { name: 'actionlint',   pattern: /\bactionlint\b/,     defaults: ['.github/workflows'] },

];

// grep is handled by a dedicated regex below — it's too awkward for the
// generic token-walker because the first positional is always a pattern
// (often containing shell metacharacters) and flag handling is terse.

// `uses:` actions that cover the whole repo (secret scan, SAST, global lint)
const WHOLE_REPO_ACTIONS = [
  /github\/codeql-action/i,
  /trufflesecurity\/trufflehog/i,
  /gitleaks\/gitleaks-action/i,
  /github\/super-linter/i,
  /super-linter/i,
  /aquasecurity\/trivy-action/i,
];

// ── Tokenizer ──

/**
 * Tokenize a shell-ish command line, preserving quoted strings as
 * single tokens and replacing $vars with a placeholder (so they don't
 * get mistaken for paths).
 */
function tokenizeCommandLine(line: string): string[] {
  const quotes: string[] = [];
  let s = line.replace(/"[^"]*"|'[^']*'/g, (m) => {
    quotes.push(m.slice(1, -1));
    return `__Q${quotes.length - 1}__`;
  });
  s = s.replace(/\$\{[^}]+\}/g, '__VAR__');
  s = s.replace(/\$\w+/g, '__VAR__');
  const tokens = s.split(/\s+/).filter(Boolean);
  return tokens.map((t) => {
    const m = /^__Q(\d+)__$/.exec(t);
    return m ? quotes[parseInt(m[1], 10)] : t;
  });
}

// ── Path normalization ──

/**
 * Normalize a path arg extracted from CI. Strips leading `./`, trailing
 * slashes, Go's `/...` suffix, glob stars. Returns `'.'` for repo root.
 * Returns empty string for inputs that don't look like repo-relative
 * paths (absolute paths, URLs, empty).
 */
function normalizePath(p: string): string {
  if (!p) return '';
  let s = p;
  s = s.replace(/^["']|["']$/g, '');
  // Absolute paths can never match a repo-relative source file.
  if (s.startsWith('/') || /^[A-Za-z]:\\/.test(s)) return '';
  // URLs
  if (/^https?:\/\//.test(s)) return '';
  // Go-style: ./... or pkg/...
  if (s === '...' || s === './...') return '.';
  s = s.replace(/\/\.\.\.$/, '');
  s = s.replace(/^\.\//, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/\*\*\/.*$/, '');
  s = s.replace(/\/\*\*$/, '');
  s = s.replace(/\/\*.*$/, '');
  if (s === '' || s === '.') return '.';
  return s;
}

/**
 * Does this token look like a path we want to claim as coverage?
 * Rules out obvious non-paths (env vars, flags, URLs).
 */
function looksLikePath(tok: string): boolean {
  if (!tok) return false;
  if (tok.startsWith('-')) return false;
  if (tok.startsWith('__VAR__')) return false;
  if (tok.startsWith('__Q')) return false;
  if (/^https?:\/\//.test(tok)) return false;
  if (tok.includes('=') && !tok.includes('/')) return false;
  return true;
}

// ── Per-line extraction ──

// Shell keywords that break a command stream. We replace them with a
// separator before splitting into simple commands, so `if ! grep foo
// file; then echo ok; fi` becomes individual commands we can analyze.
const SHELL_CONTROL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'while', 'do', 'done',
  'case', 'esac',
  'for', 'in', 'function', 'return',
  '!',
]);

// Leading tokens to strip before identifying the tool (wrappers and
// env-var assignments like `FOO=bar pytest tests/` or `sudo pytest`).
const LEADING_STRIP_TOKENS = new Set(['sudo', 'time', 'nice', 'env', 'exec']);

function stripLeading(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (LEADING_STRIP_TOKENS.has(t)) { i++; continue; }
    if (SHELL_CONTROL_KEYWORDS.has(t)) { i++; continue; }
    // Env var: FOO=bar
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    break;
  }
  return tokens.slice(i);
}

/**
 * If a command starts with the given tool (possibly through a known
 * wrapper like `python -m X`, `npx X`, `pnpm exec X`), return the
 * index where the tool's positional args begin. Otherwise return -1.
 */
function commandMatchesTool(tokens: string[], tool: ToolMatcher): number {
  if (tokens.length === 0) return -1;
  const toolWords = tool.name.split(/\s+/);

  // Direct: tokens[0..n] match toolWords exactly
  let direct = true;
  for (let i = 0; i < toolWords.length; i++) {
    if (tokens[i] !== toolWords[i]) { direct = false; break; }
  }
  if (direct) return toolWords.length;

  // python -m TOOL  (for single-word tools only)
  if (toolWords.length === 1 && tokens.length >= 3) {
    if (
      (tokens[0] === 'python' || tokens[0] === 'python3' || tokens[0] === 'python2') &&
      tokens[1] === '-m' &&
      tokens[2] === toolWords[0]
    ) {
      return 3;
    }
  }

  // npx TOOL, pnpx TOOL
  if (toolWords.length === 1 && tokens.length >= 2) {
    if ((tokens[0] === 'npx' || tokens[0] === 'pnpx') && tokens[1] === toolWords[0]) {
      return 2;
    }
  }

  // pnpm exec TOOL, yarn exec TOOL
  if (toolWords.length === 1 && tokens.length >= 3) {
    if (
      (tokens[0] === 'pnpm' || tokens[0] === 'yarn') &&
      tokens[1] === 'exec' &&
      tokens[2] === toolWords[0]
    ) {
      return 3;
    }
  }

  return -1;
}

/**
 * Split a shell-ish content block into "simple commands" by replacing
 * shell control flow constructs with a command separator, then splitting
 * on separators. Not a real shell parser — good enough to turn
 *
 *     if ! grep -q "foo" file; then echo ok; fi
 *
 * into `['grep -q "foo" file', 'echo ok']`.
 */
function splitIntoSimpleCommands(block: string): string[] {
  // Preserve quoted strings first so we don't tokenize inside them
  const quotes: string[] = [];
  let s = block.replace(/"[^"]*"|'[^']*'/g, (m) => {
    quotes.push(m);
    return `__Q${quotes.length - 1}__`;
  });
  // Replace shell keywords with a separator (as whole words)
  s = s.replace(/\b(if|then|else|elif|fi|while|do|done|case|esac|for|in|function|return)\b/g, '###');
  // Shell metacharacters become separators
  s = s.replace(/[!(){}]/g, '###');
  // Real shell command separators
  s = s.replace(/&&|\|\||;|\|(?!\|)/g, '###');
  // Restore quotes
  s = s.replace(/__Q(\d+)__/g, (_m, idx) => quotes[parseInt(idx, 10)]);
  return s.split('###').map((x) => x.trim()).filter(Boolean);
}

/**
 * Extract covered path prefixes from a single command or content line.
 */
function extractPathsFromLine(line: string): Set<string> {
  const covered = new Set<string>();
  const commands = splitIntoSimpleCommands(line);

  for (const cmd of commands) {
    if (!cmd) continue;

    // Dedicated pass: `python scripts/foo.py`, `bash script.sh`
    // The script file is verified (syntax error → step fails)
    const pyScriptRe = /(?:^|[\s;&|])python[23]?\s+((?:[A-Za-z0-9_./\-]+\/)?[A-Za-z0-9_.\-]+\.py)\b/g;
    for (const m of cmd.matchAll(pyScriptRe)) {
      const n = normalizePath(m[1]);
      if (n) covered.add(n);
    }
    const shScriptRe = /(?:^|[\s;&|])(?:ba)?sh\s+((?:[A-Za-z0-9_./\-]+\/)?[A-Za-z0-9_.\-]+\.(?:sh|bash))\b/g;
    for (const m of cmd.matchAll(shScriptRe)) {
      const n = normalizePath(m[1]);
      if (n) covered.add(n);
    }
    // `docker cp LOCAL_PATH CONTAINER:/remote/path` — LOCAL_PATH is
    // verified in the sense that a missing/broken file fails the step.
    const dockerCpRe = /\bdocker\s+cp\s+([A-Za-z0-9_./\-]+)\s+\S+:\S+/g;
    for (const m of cmd.matchAll(dockerCpRe)) {
      const n = normalizePath(m[1]);
      if (n) covered.add(n);
    }
    // `grep [flags] PATTERN FILE` — an invariant check on a source
    // file counts as CI verifying that file. The pattern token is not
    // allowed to start with `-` (otherwise regex backtracking lets a
    // flag like `-i` pose as the pattern and the next token pose as
    // the path — which wrongly captured e.g. `grep -i redis` as if
    // `redis` were a source path).
    const grepRe = /(?:^|[\s;&|!])grep\s+(?:-\S+\s+)*(?:"[^"]*"|'[^']*'|(?!-)\S+)\s+(?!-)([^\s;|&]+)/g;
    for (const m of cmd.matchAll(grepRe)) {
      const n = normalizePath(m[1]);
      if (n) covered.add(n);
    }

    // Tokenize and strip leading wrappers / env vars
    let tokens = tokenizeCommandLine(cmd);
    tokens = stripLeading(tokens);
    if (tokens.length === 0) continue;

    // Try each tool matcher against the command HEAD (not substring).
    for (const tool of TOOL_MATCHERS) {
      const argsStart = commandMatchesTool(tokens, tool);
      if (argsStart === -1) continue;

      const args = tokens.slice(argsStart);
      const positionals: string[] = [];
      let i = 0;
      let skippedFirst = false;
      while (i < args.length) {
        const tok = args[i];
        if (tok.startsWith('-')) {
          if (tool.flagsWithArg?.has(tok)) { i += 2; continue; }
          i++;
          continue;
        }
        if (!looksLikePath(tok)) { i++; continue; }
        if (tool.skipFirstArg && !skippedFirst) {
          skippedFirst = true;
          i++;
          continue;
        }
        positionals.push(tok);
        i++;
      }

      const chosen = tool.lastOnly && positionals.length > 0
        ? [positionals[positionals.length - 1]]
        : positionals;
      const results = chosen.length > 0 ? chosen : tool.defaults;
      for (const p of results) {
        const n = normalizePath(p);
        if (n) covered.add(n);
      }

      // Stop on first tool match for this command — prevents `go test`
      // also matching `go build` on an unrelated command and doubling up.
      break;
    }
  }

  return covered;
}

// ── Workflow content parsing ──

/**
 * Walk CI workflow content line-by-line, extracting covered path
 * prefixes from `run:` commands (both inline and block scalars) and
 * from `uses:` references to whole-repo actions (codeql, trufflehog,
 * gitleaks, super-linter, trivy).
 *
 * Not a real YAML parser. Tolerant of indentation and comment lines.
 */
export function extractCoveredPaths(
  ciConfigFiles: Array<{ path: string; content: string }>
): Set<string> {
  const covered = new Set<string>();

  for (const f of ciConfigFiles) {
    const content = f.content;

    // Whole-repo `uses:` actions
    for (const re of WHOLE_REPO_ACTIONS) {
      if (re.test(content)) {
        covered.add('.');
      }
    }

    const lines = content.split('\n');
    let inRunBlock = false;
    let runBlockIndent = -1;

    for (const line of lines) {
      // Skip pure comment lines
      if (/^\s*#/.test(line)) {
        if (inRunBlock) {
          // A comment inside a run block is part of the block
          continue;
        }
        continue;
      }

      // Detect `run: |` or `run: >` block start
      const runBlockStart = /^(\s*)-?\s*run\s*:\s*[|>][+-]?\s*(?:#.*)?$/.exec(line);
      if (runBlockStart) {
        inRunBlock = true;
        runBlockIndent = runBlockStart[1].length;
        continue;
      }

      // Detect single-line `run: cmd`
      const runSingle = /^\s*-?\s*run\s*:\s*(\S.*)$/.exec(line);
      if (runSingle && !/[|>][+-]?\s*$/.test(line)) {
        // Avoid re-matching block start lines
        const paths = extractPathsFromLine(runSingle[1]);
        for (const p of paths) covered.add(p);
        continue;
      }

      // Inside a run: | block — check indent
      if (inRunBlock) {
        if (line.trim() === '') continue;
        const indent = /^(\s*)/.exec(line)![1].length;
        if (indent <= runBlockIndent) {
          inRunBlock = false;
          runBlockIndent = -1;
          // fall through to try matching other constructs on this line
        } else {
          const paths = extractPathsFromLine(line);
          for (const p of paths) covered.add(p);
          continue;
        }
      }
    }
  }

  return covered;
}

// ── Coverage computation ──

function groupByExt(
  files: SourceFile[],
  isCovered: (f: SourceFile) => boolean
): Record<string, { covered_loc: number; total_loc: number }> {
  const out: Record<string, { covered_loc: number; total_loc: number }> = {};
  for (const f of files) {
    const k = f.ext || '(none)';
    if (!out[k]) out[k] = { covered_loc: 0, total_loc: 0 };
    out[k].total_loc += f.loc;
    if (isCovered(f)) out[k].covered_loc += f.loc;
  }
  return out;
}

function groupByTopDir(
  files: SourceFile[],
  isCovered: (f: SourceFile) => boolean
): Record<string, { covered_loc: number; total_loc: number }> {
  const out: Record<string, { covered_loc: number; total_loc: number }> = {};
  for (const f of files) {
    const k = f.topDir;
    if (!out[k]) out[k] = { covered_loc: 0, total_loc: 0 };
    out[k].total_loc += f.loc;
    if (isCovered(f)) out[k].covered_loc += f.loc;
  }
  return out;
}

function topUncoveredDirs(
  files: SourceFile[],
  isCovered: (f: SourceFile) => boolean
): Array<{ dir: string; loc: number }> {
  const buckets: Record<string, number> = {};
  for (const f of files) {
    if (isCovered(f)) continue;
    // Use up to 2 levels of nesting for granularity
    const parts = f.path.split('/');
    const dir = parts.length >= 3
      ? `${parts[0]}/${parts[1]}`
      : parts.length === 2
        ? parts[0]
        : '.';
    buckets[dir] = (buckets[dir] || 0) + f.loc;
  }
  return Object.entries(buckets)
    .map(([dir, loc]) => ({ dir, loc }))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 10);
}

/**
 * Main entry: compute CI line-level coverage for a cloned repo + its
 * extracted CI config files.
 *
 * - If the repo has no source files at all → fallback_reason='no_source_files'
 * - If the repo has source files but no CI config → fallback_reason='no_ci'
 * - If CI exists but no verifying step was detected → fallback_reason='no_verifying_steps_detected'
 *
 * In all fallback cases, covered_loc=0 and coverage_ratio=0.
 */
export function computeCICoverage(
  repoDir: string,
  ciConfigFiles: Array<{ path: string; content: string }>
): CICoverageResult {
  const files = enumerateSourceFiles(repoDir);
  const total_loc = files.reduce((s, f) => s + f.loc, 0);

  if (total_loc === 0) {
    return {
      covered_loc: 0,
      total_loc: 0,
      coverage_ratio: 0,
      total_files: 0,
      covered_files: 0,
      covered_paths: [],
      by_extension: {},
      by_top_dir: {},
      top_uncovered_dirs: [],
      fallback_reason: 'no_source_files',
    };
  }

  const coveredPaths = extractCoveredPaths(ciConfigFiles);

  if (coveredPaths.size === 0) {
    const alwaysFalse = () => false;
    return {
      covered_loc: 0,
      total_loc,
      coverage_ratio: 0,
      total_files: files.length,
      covered_files: 0,
      covered_paths: [],
      by_extension: groupByExt(files, alwaysFalse),
      by_top_dir: groupByTopDir(files, alwaysFalse),
      top_uncovered_dirs: topUncoveredDirs(files, alwaysFalse),
      fallback_reason: ciConfigFiles.length === 0 ? 'no_ci' : 'no_verifying_steps_detected',
    };
  }

  const pathArr = [...coveredPaths];
  const isCovered = (f: SourceFile): boolean => {
    if (coveredPaths.has('.')) return true;
    for (const p of pathArr) {
      if (f.path === p) return true;
      if (f.path.startsWith(p + '/')) return true;
    }
    return false;
  };

  let covered_loc = 0;
  let covered_files = 0;
  for (const f of files) {
    if (isCovered(f)) {
      covered_loc += f.loc;
      covered_files++;
    }
  }

  return {
    covered_loc,
    total_loc,
    coverage_ratio: covered_loc / total_loc,
    total_files: files.length,
    covered_files,
    covered_paths: pathArr.sort(),
    by_extension: groupByExt(files, isCovered),
    by_top_dir: groupByTopDir(files, isCovered),
    top_uncovered_dirs: topUncoveredDirs(files, isCovered),
  };
}
