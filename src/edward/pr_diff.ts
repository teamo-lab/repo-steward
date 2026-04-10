/**
 * PR diff loader — fetches a GitHub PR's unified diff via the `gh` CLI
 * (already a hard dependency of Edward) and parses it into a structured
 * shape the review pipeline can reason about.
 *
 * Why `gh pr diff` instead of the PyGithub-based pr-agent subprocess:
 * `gh pr diff` already handles merge-base resolution correctly, returns
 * a canonical unified diff, and inherits the user's auth. Introducing a
 * Python subprocess just to reach pr-agent's `get_diff_files()` buys us
 * nothing we actually need for Sprint 1.
 *
 * Zero runtime deps — this file only shells out to `gh`.
 */

import { execSync } from 'node:child_process';

// ── Public types ──

export interface PRHunk {
  /** First line number of the pre-image range (1-based). */
  old_start: number;
  old_lines: number;
  /** First line number of the post-image range (1-based). */
  new_start: number;
  new_lines: number;
  /**
   * Raw hunk body including the leading ' '/'+'/'-' markers, one line
   * per entry. The leading `@@` header is NOT included — the start/lines
   * fields already carry that information.
   */
  patch: string;
}

export interface PRFile {
  path: string;
  change: 'added' | 'deleted' | 'modified' | 'renamed';
  /** Populated only when change === 'renamed'. */
  old_path?: string;
  hunks: PRHunk[];
}

export interface PRMetadata {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
}

export interface PRDiffLoadResult {
  meta: PRMetadata;
  files: PRFile[];
  total_changed_lines: number;
  /**
   * True if the PR exceeds Sprint 1 size guards. When set, callers
   * should refuse to invoke the LLM pipeline and surface a "too large"
   * notice instead.
   */
  too_large: boolean;
  size_guard: {
    max_files: number;
    max_changed_lines: number;
    actual_files: number;
    actual_changed_lines: number;
  };
}

export interface PRDiffLoadOptions {
  /** File count cap. Default 50. */
  maxFiles?: number;
  /** Total (additions + deletions) line cap. Default 5000. */
  maxChangedLines?: number;
}

// ── URL / number parsing ──

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePRReference(
  input: string,
  repoHint?: string
): { owner: string; repo: string; number: number } | null {
  const trimmed = input.trim();
  const m = trimmed.match(PR_URL_RE);
  if (m) {
    return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
  }
  if (/^\d+$/.test(trimmed) && repoHint) {
    const repoMatch = repoHint.match(/^([^/]+)\/([^/]+)$/);
    if (!repoMatch) return null;
    return { owner: repoMatch[1]!, repo: repoMatch[2]!, number: Number(trimmed) };
  }
  return null;
}

// ── gh CLI wrappers ──

function shSafeArg(s: string): string {
  // gh arguments we build are all url-safe / numeric in practice, but
  // keep a defensive quote to avoid shell surprises.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function runGh(args: string): string {
  try {
    return execSync(`gh ${args}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.message || '').slice(0, 400);
    throw new Error(`gh ${args.split(' ')[0]} failed: ${stderr}`);
  }
}

function fetchMetadata(ref: { owner: string; repo: string; number: number }): PRMetadata {
  const repoSlug = `${ref.owner}/${ref.repo}`;
  const fields = 'title,body,author,baseRefName,headRefName,headRefOid';
  const raw = runGh(
    `pr view ${ref.number} --repo ${shSafeArg(repoSlug)} --json ${fields}`
  );
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`gh pr view returned non-JSON: ${raw.slice(0, 200)}`);
  }
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: String(parsed.title || ''),
    body: String(parsed.body || ''),
    author: String(parsed.author?.login || ''),
    base_ref: String(parsed.baseRefName || ''),
    head_ref: String(parsed.headRefName || ''),
    head_sha: String(parsed.headRefOid || ''),
  };
}

function fetchUnifiedDiff(ref: { owner: string; repo: string; number: number }): string {
  const repoSlug = `${ref.owner}/${ref.repo}`;
  return runGh(`pr diff ${ref.number} --repo ${shSafeArg(repoSlug)} --patch`);
}

// ── Unified diff parser ──

/**
 * Parse a unified diff (the kind `git diff` / `gh pr diff --patch` emits)
 * into PRFile[]. Handles added / deleted / modified / renamed paths.
 * Binary patches are skipped (marked as modified with zero hunks).
 */
export function parseUnifiedDiff(text: string): PRFile[] {
  const lines = text.split('\n');
  const files: PRFile[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (!line.startsWith('diff --git ')) {
      cursor++;
      continue;
    }

    // Header line example: `diff --git a/src/foo.ts b/src/foo.ts`
    const headerMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const defaultPath = headerMatch ? headerMatch[2]! : '';
    let oldPath: string | undefined;
    let change: PRFile['change'] = 'modified';
    let filePath = defaultPath;

    cursor++;
    // Eat metadata lines until we reach the first `@@` hunk header or
    // the next file's `diff --git` line.
    while (cursor < lines.length) {
      const meta = lines[cursor]!;
      if (meta.startsWith('diff --git ') || meta.startsWith('@@ ')) break;
      if (meta.startsWith('new file mode')) change = 'added';
      else if (meta.startsWith('deleted file mode')) change = 'deleted';
      else if (meta.startsWith('rename from ')) {
        change = 'renamed';
        oldPath = meta.slice('rename from '.length).trim();
      } else if (meta.startsWith('rename to ')) {
        filePath = meta.slice('rename to '.length).trim();
      } else if (meta.startsWith('--- a/')) {
        if (change !== 'added') oldPath = meta.slice('--- a/'.length).trim();
      } else if (meta.startsWith('+++ b/')) {
        filePath = meta.slice('+++ b/'.length).trim();
      } else if (meta === 'Binary files differ' || /^Binary files .* differ$/.test(meta)) {
        // Binary patch — leave as zero-hunk modified entry.
      }
      cursor++;
    }

    const hunks: PRHunk[] = [];
    while (cursor < lines.length && lines[cursor]!.startsWith('@@ ')) {
      const header = lines[cursor]!;
      const hunkHeaderMatch = header.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      );
      if (!hunkHeaderMatch) {
        cursor++;
        continue;
      }
      const old_start = Number(hunkHeaderMatch[1]);
      const old_lines = hunkHeaderMatch[2] !== undefined ? Number(hunkHeaderMatch[2]) : 1;
      const new_start = Number(hunkHeaderMatch[3]);
      const new_lines = hunkHeaderMatch[4] !== undefined ? Number(hunkHeaderMatch[4]) : 1;
      cursor++;

      const bodyLines: string[] = [];
      while (cursor < lines.length) {
        const b = lines[cursor]!;
        if (b.startsWith('diff --git ') || b.startsWith('@@ ')) break;
        // Unified diff body lines start with ' ', '+', '-', or '\' (for
        // "\ No newline at end of file"). Anything else means we've
        // walked past the body (shouldn't happen with well-formed diffs).
        if (b.length > 0 && !' +-\\'.includes(b[0]!)) break;
        bodyLines.push(b);
        cursor++;
      }
      hunks.push({
        old_start,
        old_lines,
        new_start,
        new_lines,
        patch: bodyLines.join('\n'),
      });
    }

    files.push({
      path: filePath,
      change,
      ...(oldPath && oldPath !== filePath ? { old_path: oldPath } : {}),
      hunks,
    });
  }

  return files;
}

// ── Top-level loader ──

export async function loadPRDiff(
  input: string,
  opts?: PRDiffLoadOptions & { repoHint?: string }
): Promise<PRDiffLoadResult> {
  const ref = parsePRReference(input, opts?.repoHint);
  if (!ref) {
    throw new Error(
      `Could not parse PR reference "${input}". Accepted forms: ` +
      `"https://github.com/<owner>/<repo>/pull/<n>" or "<n> --repo <owner>/<repo>".`
    );
  }

  const maxFiles = opts?.maxFiles ?? 50;
  const maxChangedLines = opts?.maxChangedLines ?? 5000;

  const meta = fetchMetadata(ref);
  const diffText = fetchUnifiedDiff(ref);
  const files = parseUnifiedDiff(diffText);

  let totalChanged = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      const body = h.patch.split('\n');
      for (const b of body) {
        if (b.startsWith('+') || b.startsWith('-')) totalChanged++;
      }
    }
  }

  const tooLarge = files.length > maxFiles || totalChanged > maxChangedLines;

  return {
    meta,
    files,
    total_changed_lines: totalChanged,
    too_large: tooLarge,
    size_guard: {
      max_files: maxFiles,
      max_changed_lines: maxChangedLines,
      actual_files: files.length,
      actual_changed_lines: totalChanged,
    },
  };
}
