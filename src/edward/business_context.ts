/**
 * Business Context — the "what does this project do and what must be
 * true about it" input that makes Edward's CI audit produce findings
 * about FUNCTIONAL gaps ("no test covers the rate-limit rule on the
 * signup endpoint") instead of INFRASTRUCTURE gaps ("add dependabot").
 *
 * Source priority (first that yields a context wins):
 *   1. `.edward/context.yml`  — hand-maintained, highest quality
 *   2. `.edward/context.json` — same schema, JSON
 *   3. Auto-extract from README / OpenAPI / framework metadata
 *      — ~60% precision, zero user effort
 *
 * The schema is intentionally language-agnostic. Nothing in here names
 * a specific framework or project. Every field maps to a claim about
 * business behavior that CI should be enforcing.
 *
 * Not a full YAML parser: we support a pragmatic subset covering the
 * shape defined below. This is zero-dep by design — Edward must not
 * ship a YAML library just for this.
 */

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { CIRawConfig } from './ci_extract.js';
import type { RepoProfile } from './profile.js';
import { invokeLLMWithFallback, type Provider } from './llm_provider.js';
import type { FeatureSurface } from './feature_inventory.js';

// ── Public types ──

export type InvariantSeverity = 'low' | 'medium' | 'high';

export interface CriticalInvariant {
  /** stable id, [a-z0-9_] */
  id: string;
  /** One-sentence human description of the rule. */
  description: string;
  /** Severity if broken. */
  severity: InvariantSeverity;
}

export interface CriticalFlow {
  /** stable id, [a-z0-9_] */
  id: string;
  /** Human-readable name. */
  name: string;
  /**
   * Code locations that implement this flow. Fuzzy strings — paths,
   * module names, function names, route patterns. Used as hints for
   * matching against the FeatureSurface layer.
   */
  entry_points: string[];
  /** Business invariants this flow must uphold. */
  invariants: CriticalInvariant[];
}

export interface ModelContract {
  /** Library name, e.g. "openai" / "anthropic" / "bedrock". Free-form. */
  library: string;
  /** Allowed model identifiers for this library. */
  allowed_models?: string[];
  /** Numeric parameter ranges keyed by param name. */
  param_ranges?: Record<string, [number, number]>;
}

export interface BusinessContext {
  project: {
    name: string;
    domain: string;
    summary: string;
  };
  critical_flows: CriticalFlow[];
  model_contracts: ModelContract[];
  /** Explicit negative rules — "this must NEVER be true". */
  forbidden: string[];
  /** How the context was sourced — informational only, not used in matching. */
  source: 'context.yml' | 'context.json' | 'auto_extracted' | 'user_cache' | 'user_override' | 'empty';
}

export const EMPTY_CONTEXT: BusinessContext = {
  project: { name: '', domain: '', summary: '' },
  critical_flows: [],
  model_contracts: [],
  forbidden: [],
  source: 'empty',
};

// ── Entrypoint ──

export interface LoadContextOptions {
  provider?: Provider;
  /** Whether to LLM-auto-extract if no file source exists. */
  allowAutoExtract?: boolean;
  /** Optional feature surface to inject into the auto-extract prompt — makes inference from code-only repos possible. */
  featureSurface?: FeatureSurface;
  /** Absolute file path (yml/yaml/json). Highest priority, beats everything else. */
  overridePath?: string;
  /** Canonical slug for the repo (e.g. "owner_repo"), used to locate the per-repo cache file in ~/.edward/contexts/. */
  repoSlug?: string;
  /** Force regeneration: ignore cache and file-based sources, go straight to auto-extract. */
  forceRegenerate?: boolean;
}

/**
 * Load business context for a cloned repo. Tries sources in priority
 * order:
 *
 *   1. `overridePath` (CLI --context-file)
 *   2. `EDWARD_CONTEXT_FILE` env var
 *   3. `~/.edward/contexts/<slug>.yml|yaml|json` user cache
 *   4. `<repoDir>/.edward/context.yml|yaml|json` committed file
 *   5. LLM auto-extract from README / OpenAPI / code signals (if
 *      `allowAutoExtract`)
 *
 * Setting `forceRegenerate` skips steps 1-4 and goes straight to
 * auto-extract. Never throws — returns EMPTY_CONTEXT on total failure.
 */
export async function loadBusinessContext(
  repoDir: string,
  opts?: LoadContextOptions
): Promise<BusinessContext> {
  // 1. Explicit override path
  if (!opts?.forceRegenerate && opts?.overridePath) {
    const ctx = tryLoadFromAbsPath(opts.overridePath, 'user_override');
    if (ctx) return ctx;
  }

  // 2. Env var
  if (!opts?.forceRegenerate && process.env.EDWARD_CONTEXT_FILE) {
    const ctx = tryLoadFromAbsPath(process.env.EDWARD_CONTEXT_FILE, 'user_override');
    if (ctx) return ctx;
  }

  // 3. User cache keyed by repo slug
  if (!opts?.forceRegenerate && opts?.repoSlug) {
    const cachePath = getContextCachePath(opts.repoSlug);
    const ctx = tryLoadFromAbsPath(cachePath, 'user_cache');
    if (ctx) return ctx;
  }

  // 4. Committed in-repo files
  if (!opts?.forceRegenerate) {
    const yml = join(repoDir, '.edward', 'context.yml');
    const yaml = join(repoDir, '.edward', 'context.yaml');
    const jsonPath = join(repoDir, '.edward', 'context.json');
    for (const p of [yml, yaml]) {
      const ctx = tryLoadFromAbsPath(p, 'context.yml');
      if (ctx) return ctx;
    }
    const fromJson = tryLoadFromAbsPath(jsonPath, 'context.json');
    if (fromJson) return fromJson;
  }

  // 5. Auto-extract
  if (opts?.allowAutoExtract) {
    try {
      return await autoExtractContext(repoDir, opts.provider, opts.featureSurface);
    } catch (err: any) {
      console.error(`[edward] auto-extract business context failed: ${err?.message || err}`);
    }
  }

  return { ...EMPTY_CONTEXT };
}

/**
 * Try to load a context from an absolute file path. Returns null if
 * the file doesn't exist or can't be parsed. Supports .yml / .yaml
 * (YAML subset) and .json.
 */
function tryLoadFromAbsPath(
  absPath: string,
  source: BusinessContext['source']
): BusinessContext | null {
  if (!safeExists(absPath)) return null;
  try {
    const text = readFileSync(absPath, 'utf-8');
    if (absPath.endsWith('.json')) {
      const raw = JSON.parse(text);
      return normalizeContext(raw, source);
    }
    // Assume YAML otherwise
    const ctx = parseContextYaml(text);
    return { ...ctx, source };
  } catch (err: any) {
    console.error(`[edward] failed to load context from ${absPath}: ${err?.message || err}`);
    return null;
  }
}

// ── User-level cache ──

/**
 * Canonical path where Edward stores per-repo context overrides the
 * user has approved/edited. Lives under ~/.edward/contexts/ so it
 * survives across discover runs but is not committed.
 *
 * `.yml` extension by default — when Edward writes a generated
 * context, it uses the YAML serializer so the user can hand-edit it.
 */
export function getContextCachePath(slug: string): string {
  const safeSlug = slug.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(homedir(), '.edward', 'contexts', `${safeSlug}.yml`);
}

/**
 * Derive the cache slug from an `owner/repo` full name.
 */
export function slugForRepo(fullName: string): string {
  return fullName.replace(/\//g, '_');
}

/**
 * Persist a BusinessContext to its user-cache path as YAML. Creates
 * parent directories on demand. Returns the absolute path written.
 */
export function writeContextToCache(slug: string, ctx: BusinessContext): string {
  const absPath = getContextCachePath(slug);
  const dir = dirname(absPath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const yaml = serializeContextToYaml(ctx);
  writeFileSync(absPath, yaml, 'utf-8');
  return absPath;
}

function safeExists(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

// ── YAML parser (minimal subset) ──

/**
 * Parse the subset of YAML we need for BusinessContext:
 *   - 2-space indentation only
 *   - scalar values (bare, single-quoted, double-quoted)
 *   - integer / float / bool / null scalars
 *   - nested maps
 *   - list items via `-` (inline or block)
 *   - list of maps via `- key: value` followed by indented siblings
 *   - line comments starting with `#` (full-line or trailing)
 *   - inline arrays `[a, b, c]` for simple scalars
 *
 * NOT supported: anchors, tags, multi-line scalars, flow maps `{...}`,
 * tab indentation. These are not used in our schema.
 *
 * Throws on severe structural problems; returns best-effort on mild
 * ones.
 */
export function parseContextYaml(text: string): BusinessContext {
  const raw = parseYamlSubset(text);
  return normalizeContext(raw, 'context.yml');
}

interface ParsedLine {
  indent: number;
  raw: string;
  trimmed: string;
  /** Pre-collected folded-block scalar value, if the previous `key: |` / `key: >` set one. */
  blockScalar?: string;
}

function parseYamlSubset(text: string): any {
  const rawLines = text.split('\n');
  const parsed: ParsedLine[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    // Strip trailing comments but respect quoted strings
    const stripped = stripTrailingComment(line);
    if (stripped.trim() === '' || stripped.trim().startsWith('#')) {
      i++;
      continue;
    }
    const indent = stripped.search(/\S/);
    const trimmed = stripped.trim();

    // Block scalar: `key: |` or `key: >` — collect following
    // indented lines as the scalar value and store inline.
    const blockMatch = /^([^#:]+):\s*([|>])[+-]?\s*$/.exec(trimmed);
    if (blockMatch) {
      const [, key, style] = blockMatch;
      const collected: string[] = [];
      i++;
      const baseIndent = indent;
      let firstChildIndent = -1;
      while (i < rawLines.length) {
        const next = rawLines[i];
        if (next.trim() === '') { collected.push(''); i++; continue; }
        const ni = next.search(/\S/);
        if (ni <= baseIndent) break;
        if (firstChildIndent < 0) firstChildIndent = ni;
        collected.push(next.slice(firstChildIndent));
        i++;
      }
      // Drop trailing empty lines
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      const joined = style === '>'
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n');
      // Rewrite as a single scalar line
      parsed.push({
        indent: baseIndent,
        raw: `${' '.repeat(baseIndent)}${key.trim()}: __BLOCK_SCALAR__`,
        trimmed: `${key.trim()}: __BLOCK_SCALAR__`,
        blockScalar: joined,
      });
      continue;
    }

    parsed.push({ indent, raw: stripped, trimmed });
    i++;
  }

  // Stack-based parser
  let idx = 0;

  function parseValue(expectedIndent: number): any {
    if (idx >= parsed.length) return null;
    const line = parsed[idx];
    if (line.indent < expectedIndent) return null;

    // List at this indent?
    if (line.trimmed.startsWith('- ') || line.trimmed === '-') {
      return parseList(expectedIndent);
    }
    // Map at this indent?
    return parseMap(expectedIndent);
  }

  function parseList(expectedIndent: number): any[] {
    const items: any[] = [];
    while (idx < parsed.length) {
      const line = parsed[idx];
      if (line.indent < expectedIndent) break;
      if (line.indent > expectedIndent) {
        throw new YamlError(`Unexpected indent in list at line ${idx + 1}`);
      }
      if (!(line.trimmed.startsWith('- ') || line.trimmed === '-')) break;
      // Consume the `- ` marker
      const rest = line.trimmed === '-' ? '' : line.trimmed.slice(2);
      if (rest === '') {
        idx++;
        // child map/list on next line with deeper indent
        items.push(parseValue(expectedIndent + 2));
        continue;
      }
      // `- key: value` form — start a map item
      if (/^\S[^:]*:\s*(.*)$/.test(rest)) {
        // Rewrite this line as a map entry and parse a map starting here
        const firstEntry = rest;
        const [k, vraw] = splitKV(firstEntry);
        const obj: any = {};
        const v = parseInlineValue(vraw);
        if (v === VALUE_IS_NESTED) {
          idx++;
          obj[k] = parseValue(expectedIndent + 2);
        } else {
          obj[k] = v;
          idx++;
        }
        // Continue collecting siblings at expectedIndent + 2
        while (idx < parsed.length) {
          const next = parsed[idx];
          if (next.indent < expectedIndent + 2) break;
          if (next.indent > expectedIndent + 2) {
            throw new YamlError(`Unexpected indent in map item at line ${idx + 1}`);
          }
          if (next.trimmed.startsWith('- ')) break;
          const [nk, nvraw] = splitKV(next.trimmed);
          const nv = parseInlineValue(nvraw);
          if (nv === VALUE_IS_NESTED) {
            idx++;
            obj[nk] = parseValue(expectedIndent + 4);
          } else {
            obj[nk] = nv;
            idx++;
          }
        }
        items.push(obj);
        continue;
      }
      // `- scalar` form
      items.push(parseInlineValue(rest));
      idx++;
    }
    return items;
  }

  function parseMap(expectedIndent: number): Record<string, any> {
    const obj: Record<string, any> = {};
    while (idx < parsed.length) {
      const line = parsed[idx];
      if (line.indent < expectedIndent) break;
      if (line.indent > expectedIndent) {
        throw new YamlError(`Unexpected indent in map at line ${idx + 1}`);
      }
      if (line.trimmed.startsWith('- ')) break;
      const [k, vraw] = splitKV(line.trimmed);
      // Block scalar pre-collected upstream
      if (line.blockScalar !== undefined && vraw === '__BLOCK_SCALAR__') {
        obj[k] = line.blockScalar;
        idx++;
        continue;
      }
      const v = parseInlineValue(vraw);
      if (v === VALUE_IS_NESTED) {
        idx++;
        obj[k] = parseValue(expectedIndent + 2);
      } else {
        obj[k] = v;
        idx++;
      }
    }
    return obj;
  }

  return parseValue(0);
}

const VALUE_IS_NESTED = Symbol('nested');

function splitKV(line: string): [string, string] {
  const colon = line.indexOf(':');
  if (colon < 0) throw new YamlError(`Expected key:value, got: ${line}`);
  const key = line.slice(0, colon).trim();
  const val = line.slice(colon + 1).trim();
  return [key, val];
}

function parseInlineValue(raw: string): any {
  if (raw === '') return VALUE_IS_NESTED;
  // Inline array
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const body = raw.slice(1, -1).trim();
    if (body === '') return [];
    return splitTopLevel(body, ',').map((x) => parseScalar(x.trim()));
  }
  return parseScalar(raw);
}

function parseScalar(raw: string): any {
  if (raw === '') return '';
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  // Numeric?
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === inString) inString = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === '}') { depth--; buf += ch; continue; }
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function stripTrailingComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === inStr && line[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '#') return line.slice(0, i).trimEnd();
  }
  return line;
}

class YamlError extends Error {}

// ── Normalizer ──

/**
 * Take a parsed JSON/YAML blob and coerce it into a BusinessContext
 * with defaults for any missing fields. Rejects structural mismatches
 * with a friendly error but accepts flexible input (e.g., missing
 * severity defaults to medium, missing invariants list → []).
 */
export function normalizeContext(raw: any, source: BusinessContext['source']): BusinessContext {
  if (raw == null || typeof raw !== 'object') {
    return { ...EMPTY_CONTEXT, source };
  }

  const project = raw.project || {};
  const flows = Array.isArray(raw.critical_flows) ? raw.critical_flows : [];
  const contracts = Array.isArray(raw.model_contracts) ? raw.model_contracts : [];
  const forbidden = Array.isArray(raw.forbidden) ? raw.forbidden.map(String) : [];

  const normalizedFlows: CriticalFlow[] = [];
  for (const f of flows) {
    if (!f || typeof f !== 'object') continue;
    const id = String(f.id || '').trim();
    if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) continue;
    const entries = Array.isArray(f.entry_points) ? f.entry_points.map(String) : [];
    const invRaw = Array.isArray(f.invariants) ? f.invariants : [];
    const invariants: CriticalInvariant[] = [];
    for (const i of invRaw) {
      if (!i || typeof i !== 'object') continue;
      const iid = String(i.id || '').trim();
      if (!iid || !/^[a-z][a-z0-9_]*$/.test(iid)) continue;
      const sev = String(i.severity || 'medium').toLowerCase() as InvariantSeverity;
      invariants.push({
        id: iid,
        description: String(i.description || ''),
        severity: (['low', 'medium', 'high'].includes(sev) ? sev : 'medium') as InvariantSeverity,
      });
    }
    normalizedFlows.push({
      id,
      name: String(f.name || id),
      entry_points: entries,
      invariants,
    });
  }

  const normalizedContracts: ModelContract[] = [];
  for (const c of contracts) {
    if (!c || typeof c !== 'object') continue;
    const library = String(c.library || '').trim();
    if (!library) continue;
    const allowed = Array.isArray(c.allowed_models) ? c.allowed_models.map(String) : undefined;
    let param_ranges: Record<string, [number, number]> | undefined;
    if (c.param_ranges && typeof c.param_ranges === 'object') {
      param_ranges = {};
      for (const [k, v] of Object.entries(c.param_ranges)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
          param_ranges[k] = [v[0], v[1]];
        }
      }
    }
    normalizedContracts.push({ library, allowed_models: allowed, param_ranges });
  }

  return {
    project: {
      name: String(project.name || ''),
      domain: String(project.domain || ''),
      summary: String(project.summary || ''),
    },
    critical_flows: normalizedFlows,
    model_contracts: normalizedContracts,
    forbidden,
    source,
  };
}

// ── Auto-extract from repo ──

/**
 * LLM-assisted auto-extraction of business context from a repo. Uses
 * every signal we can cheaply gather, in roughly this order of trust:
 *
 *   1. README / docs — explicit product description if present
 *   2. OpenAPI / Swagger — formal API contracts
 *   3. Package manifests — project name / description / keywords
 *   4. Feature surface — enumerated routes / LLM calls / cron / queue
 *      (passed from the caller; produced by feature_inventory.ts)
 *   5. Entry-point files — main.py, index.ts, cmd/main.go docstrings
 *   6. Top-level directory tree — last resort shape hint
 *
 * The LLM is then asked to synthesize a BusinessContext from whatever
 * combination of these is available. Even a code-only repo with no
 * docs should produce a usable context via signals 3-6.
 */
export async function autoExtractContext(
  repoDir: string,
  provider?: Provider,
  featureSurface?: FeatureSurface
): Promise<BusinessContext> {
  const sources = gatherAutoExtractSources(repoDir, featureSurface);
  if (sources.totalBytes === 0) {
    return { ...EMPTY_CONTEXT };
  }

  const prompt = buildAutoExtractPrompt(sources);
  const result = await invokeLLMWithFallback(
    prompt,
    repoDir,
    {
      provider: provider ?? 'claude',
      model: provider === 'claude' || !provider ? 'sonnet' : undefined,
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      timeoutMs: 180_000,
      // Pure extraction over inlined doc snippets — no agent tools
      // needed. Prevents the claude-hangs-exploring-cwd bug on
      // large repos.
      noTools: true,
    },
    { allowFallback: true }
  );

  if (!result.ok || !result.stdout) {
    console.error(
      `[edward] auto-extract context LLM call failed: ${result.error?.slice(0, 200) || '(unknown)'}`
    );
    return { ...EMPTY_CONTEXT };
  }

  const parsed = tryParseContextJsonFromLLM(result.stdout);
  if (!parsed) {
    return { ...EMPTY_CONTEXT };
  }
  return normalizeContext(parsed, 'auto_extracted');
}

interface AutoExtractSources {
  openapi: Array<{ path: string; content: string }>;
  readme: { path: string; content: string } | null;
  docs: Array<{ path: string; content: string }>;
  manifests: Array<{ path: string; content: string }>;
  entry_points: Array<{ path: string; content: string }>;
  feature_summary: string | null;
  dir_tree: string | null;
  totalBytes: number;
}

function gatherAutoExtractSources(
  repoDir: string,
  featureSurface?: FeatureSurface
): AutoExtractSources {
  const result: AutoExtractSources = {
    openapi: [],
    readme: null,
    docs: [],
    manifests: [],
    entry_points: [],
    feature_summary: null,
    dir_tree: null,
    totalBytes: 0,
  };

  // Signal 1: README
  const readmeCandidates = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md'];
  for (const name of readmeCandidates) {
    const abs = join(repoDir, name);
    if (safeExists(abs)) {
      try {
        const content = readFileSync(abs, 'utf-8').slice(0, 50_000);
        result.readme = { path: name, content };
        result.totalBytes += content.length;
        break;
      } catch { /* ignore */ }
    }
  }

  // Signal 2: OpenAPI / Swagger
  const openapiCandidates = [
    'openapi.yaml', 'openapi.yml', 'openapi.json',
    'swagger.yaml', 'swagger.yml', 'swagger.json',
    'api/openapi.yaml', 'docs/openapi.yaml', 'docs/openapi.json',
  ];
  for (const rel of openapiCandidates) {
    const abs = join(repoDir, rel);
    if (safeExists(abs)) {
      try {
        const content = readFileSync(abs, 'utf-8').slice(0, 80_000);
        result.openapi.push({ path: rel, content });
        result.totalBytes += content.length;
      } catch { /* ignore */ }
    }
  }

  // Signal 2.5: docs/*.md — first 5 files, 20KB each, 100KB cap total
  const docsDir = join(repoDir, 'docs');
  if (safeExists(docsDir)) {
    try {
      const entries: string[] = readdirSync(docsDir);
      let budget = 100_000;
      let count = 0;
      for (const name of entries) {
        if (!/\.(md|mdx|rst)$/i.test(name)) continue;
        const abs = join(docsDir, name);
        try {
          const s = statSync(abs);
          if (!s.isFile()) continue;
          const content = readFileSync(abs, 'utf-8').slice(0, 20_000);
          if (content.length > budget) continue;
          result.docs.push({ path: `docs/${name}`, content });
          budget -= content.length;
          result.totalBytes += content.length;
          count++;
          if (count >= 5) break;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Signal 3: package manifests — name / description / keywords across stacks
  const manifestCandidates = [
    'package.json',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'Cargo.toml',
    'go.mod',
    'composer.json',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
  ];
  for (const name of manifestCandidates) {
    const abs = join(repoDir, name);
    if (safeExists(abs)) {
      try {
        const content = readFileSync(abs, 'utf-8').slice(0, 15_000);
        result.manifests.push({ path: name, content });
        result.totalBytes += content.length;
      } catch { /* ignore */ }
    }
  }

  // Signal 4: entry point files — first 4KB of each likely main entry
  const entryCandidates = [
    'main.py', 'app.py', 'server.py', 'wsgi.py', 'asgi.py', 'manage.py',
    'src/main.py', 'src/app.py',
    'index.ts', 'index.js', 'main.ts', 'server.ts', 'server.js', 'app.ts', 'app.js',
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
    'cmd/main.go', 'main.go',
    'src/main.rs',
    'Program.cs',
  ];
  let entryCount = 0;
  for (const rel of entryCandidates) {
    if (entryCount >= 3) break;
    const abs = join(repoDir, rel);
    if (safeExists(abs)) {
      try {
        const content = readFileSync(abs, 'utf-8').slice(0, 4_000);
        result.entry_points.push({ path: rel, content });
        result.totalBytes += content.length;
        entryCount++;
      } catch { /* ignore */ }
    }
  }

  // Signal 5: feature surface (from feature_inventory) — grouped by top dir
  if (featureSurface) {
    const lines: string[] = [];
    lines.push(`Total: endpoints=${featureSurface.endpoints.length}, llm_calls=${featureSurface.llm_calls.length}, cron=${featureSurface.cron_jobs.length}, queue=${featureSurface.queue_consumers.length}`);
    // Group endpoints by top-level dir
    const byDir: Record<string, string[]> = {};
    for (const f of featureSurface.endpoints) {
      const top = f.file.split('/')[0] || '.';
      if (!byDir[top]) byDir[top] = [];
      if (byDir[top].length < 8) byDir[top].push(`  ${f.label}  (${f.file}:${f.line}, ${f.framework})`);
    }
    const topDirs = Object.keys(byDir).slice(0, 12);
    for (const dir of topDirs) {
      lines.push(`\n[${dir}/] (${byDir[dir].length}+ endpoints)`);
      lines.push(...byDir[dir]);
    }
    if (featureSurface.cron_jobs.length > 0) {
      lines.push(`\nCron jobs:`);
      for (const c of featureSurface.cron_jobs.slice(0, 10)) {
        lines.push(`  ${c.label}  (${c.file}:${c.line})`);
      }
    }
    if (featureSurface.queue_consumers.length > 0) {
      lines.push(`\nQueue consumers:`);
      for (const c of featureSurface.queue_consumers.slice(0, 10)) {
        lines.push(`  ${c.label}  (${c.file}:${c.line})`);
      }
    }
    if (featureSurface.llm_calls.length > 0) {
      lines.push(`\nLLM callsites:`);
      for (const c of featureSurface.llm_calls.slice(0, 10)) {
        lines.push(`  ${c.label}  (${c.file}:${c.line})`);
      }
    }
    const summary = lines.join('\n').slice(0, 12_000);
    result.feature_summary = summary;
    result.totalBytes += summary.length;
  }

  // Signal 6: shallow directory tree
  result.dir_tree = buildShallowTree(repoDir, 2).slice(0, 4_000);
  result.totalBytes += result.dir_tree.length;

  return result;
}

function buildShallowTree(repoDir: string, maxDepth: number): string {
  const skip = new Set([
    '.git', 'node_modules', 'vendor', 'dist', 'build', 'target',
    '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache',
    'coverage', '.pytest_cache', '.mypy_cache', '.tox',
  ]);
  const lines: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }
    entries.sort();
    let emitted = 0;
    for (const name of entries) {
      if (skip.has(name)) continue;
      if (name.startsWith('.') && name !== '.github') continue;
      const full = join(abs, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      const relPath = rel ? `${rel}/${name}` : name;
      const prefix = '  '.repeat(depth);
      if (s.isDirectory()) {
        lines.push(`${prefix}${name}/`);
        walk(full, relPath, depth + 1);
      } else if (depth === 0) {
        lines.push(`${prefix}${name}`);
      }
      emitted++;
      if (emitted >= 40) break;
    }
  };
  walk(repoDir, '', 0);
  return lines.join('\n');
}

function buildAutoExtractPrompt(sources: AutoExtractSources): string {
  const blocks: string[] = [];
  if (sources.readme) {
    blocks.push(`=== README (${sources.readme.path}) ===\n${sources.readme.content}`);
  }
  if (sources.openapi.length > 0) {
    blocks.push(
      `=== OpenAPI / Swagger (${sources.openapi.length} file(s)) ===\n` +
      sources.openapi.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
    );
  }
  if (sources.docs.length > 0) {
    blocks.push(
      `=== Additional docs (${sources.docs.length} file(s)) ===\n` +
      sources.docs.map((d) => `--- ${d.path} ---\n${d.content}`).join('\n\n')
    );
  }
  if (sources.manifests.length > 0) {
    blocks.push(
      `=== Package manifests (${sources.manifests.length} file(s)) ===\n` +
      sources.manifests.map((m) => `--- ${m.path} ---\n${m.content}`).join('\n\n')
    );
  }
  if (sources.entry_points.length > 0) {
    blocks.push(
      `=== Entry-point files (${sources.entry_points.length} file(s), first ~4KB) ===\n` +
      sources.entry_points.map((e) => `--- ${e.path} ---\n${e.content}`).join('\n\n')
    );
  }
  if (sources.feature_summary) {
    blocks.push(`=== Feature surface (routes / cron / queues / LLM callsites enumerated from source code) ===\n${sources.feature_summary}`);
  }
  if (sources.dir_tree) {
    blocks.push(`=== Top-level directory tree ===\n${sources.dir_tree}`);
  }

  return `You are extracting a STRUCTURED "business context" for a code repository.
The output will be consumed by an automated CI-completeness auditor
that needs to know which business behaviors the project's CI should
verify.

Read the materials below and emit ONE JSON object that conforms
exactly to this TypeScript shape:

interface BusinessContext {
  project: {
    name: string;     // short project name
    domain: string;   // one-line business domain, e.g. "SaaS chat backend with multi-LLM routing"
    summary: string;  // 2-3 sentence product description
  };
  critical_flows: Array<{
    id: string;                 // stable slug, [a-z][a-z0-9_]*
    name: string;               // human-readable name
    entry_points: string[];     // code locations (file paths / module names / route patterns)
    invariants: Array<{
      id: string;               // stable slug, [a-z][a-z0-9_]*
      description: string;      // ONE sentence of the business rule
      severity: "low" | "medium" | "high";
    }>;
  }>;
  model_contracts: Array<{
    library: string;            // e.g. "openai", "anthropic"; empty array is fine
    allowed_models?: string[];
    param_ranges?: { [param: string]: [number, number] };
  }>;
  forbidden: string[];          // explicit "must never happen" rules
}

Guidelines:
- You may be given any subset of: README, OpenAPI, docs, package
  manifests, entry-point file contents, feature surface listing, and
  directory tree. Use whatever is available — even a code-only repo
  with no docs should yield 3-6 flows from the route list + entry
  points + package manifest.
- Critical flows come from the feature surface (HTTP endpoints / cron
  jobs / queue consumers / LLM callsites). Group related endpoints
  into a single flow when they belong to the same business concept
  (e.g., "user_auth" covering login/signup/logout/password-reset).
- For each flow, emit 1-5 invariants. When the README or docs state
  an explicit rule, use it verbatim. When they don't, INFER invariants
  from common-sense expectations for that kind of flow (rate-limit on
  auth, idempotency on payment, ownership check on user data,
  timeout on polling, atomicity on billing). Mark inferred ones with
  lower severity when in doubt.
- entry_points can be rough — file paths, handler function names, or
  route patterns are all fine. They're used as fuzzy hints.
- model_contracts only applies if the project calls an LLM API. If
  feature_surface shows llm_calls, emit contracts; if not but the
  README mentions using LLMs, still emit them. Otherwise empty array.
- forbidden captures "this must NEVER be true" rules (hardcoded
  secrets, unsafe subprocess calls, logging PII, etc.).

OUTPUT: a single JSON object, nothing else. No prose, no markdown code
fence. Start with { and end with }.

MATERIALS:

${blocks.join('\n\n')}
`;
}

function tryParseContextJsonFromLLM(text: string): any | null {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch { /* fall through */ }
  // Try to pull the first {...} block
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch { /* fall through */ }
  }
  return null;
}

// ── Summary helpers for prompts ──

/**
 * Compact JSON representation of a BusinessContext for embedding in
 * downstream prompts. Omits empty fields to keep the context block
 * small.
 */
export function contextForPrompt(ctx: BusinessContext): any {
  const out: any = {
    project: ctx.project,
    critical_flows: ctx.critical_flows.map((f) => ({
      id: f.id,
      name: f.name,
      entry_points: f.entry_points,
      invariants: f.invariants.map((i) => ({
        id: i.id,
        description: i.description,
        severity: i.severity,
      })),
    })),
  };
  if (ctx.model_contracts.length > 0) out.model_contracts = ctx.model_contracts;
  if (ctx.forbidden.length > 0) out.forbidden = ctx.forbidden;
  out.source = ctx.source;
  return out;
}

/**
 * True if the context has enough signal to drive a functional CI
 * audit. An empty context should skip the functional phase entirely
 * rather than emit meaningless "your project has no invariants"
 * findings.
 */
export function contextIsActionable(ctx: BusinessContext): boolean {
  return ctx.critical_flows.some((f) => f.invariants.length > 0);
}

// Touch unused imports to silence TS while keeping API clean.
void ({} as CIRawConfig);
void ({} as RepoProfile);

// ── YAML serializer (for writing cache files) ──

/**
 * Serialize a BusinessContext back to the YAML subset this file's
 * parser accepts. Used when writing cache files under
 * ~/.edward/contexts/ so users can hand-edit them later.
 *
 * Zero-dep, deliberately minimal. Quotes strings that contain any of
 * `:#"'-` or that would be ambiguous (true/false/null/numeric-like).
 */
export function serializeContextToYaml(ctx: BusinessContext): string {
  const lines: string[] = [];
  lines.push('# Edward business context — auto-generated or hand-edited.');
  lines.push('# See docs/edward-context.example.yml for the full schema.');
  lines.push('# This file lives under ~/.edward/contexts/ and is read on every');
  lines.push('# discover run for the corresponding repo. Safe to hand-edit.');
  lines.push('');

  lines.push('project:');
  lines.push(`  name: ${yamlString(ctx.project.name)}`);
  lines.push(`  domain: ${yamlString(ctx.project.domain)}`);
  lines.push(`  summary: ${yamlString(ctx.project.summary)}`);
  lines.push('');

  lines.push('critical_flows:');
  if (ctx.critical_flows.length === 0) {
    lines.push('  []');
  } else {
    for (const f of ctx.critical_flows) {
      lines.push(`  - id: ${yamlString(f.id)}`);
      lines.push(`    name: ${yamlString(f.name)}`);
      lines.push(`    entry_points:`);
      if (f.entry_points.length === 0) {
        lines.push(`      []`);
      } else {
        for (const ep of f.entry_points) {
          lines.push(`      - ${yamlString(ep)}`);
        }
      }
      lines.push(`    invariants:`);
      if (f.invariants.length === 0) {
        lines.push(`      []`);
      } else {
        for (const inv of f.invariants) {
          lines.push(`      - id: ${yamlString(inv.id)}`);
          lines.push(`        description: ${yamlString(inv.description)}`);
          lines.push(`        severity: ${inv.severity}`);
        }
      }
    }
  }
  lines.push('');

  lines.push('model_contracts:');
  if (ctx.model_contracts.length === 0) {
    lines.push('  []');
  } else {
    for (const c of ctx.model_contracts) {
      lines.push(`  - library: ${yamlString(c.library)}`);
      if (c.allowed_models && c.allowed_models.length > 0) {
        lines.push(`    allowed_models: [${c.allowed_models.map(yamlString).join(', ')}]`);
      }
      if (c.param_ranges && Object.keys(c.param_ranges).length > 0) {
        lines.push(`    param_ranges:`);
        for (const [k, v] of Object.entries(c.param_ranges)) {
          lines.push(`      ${k}: [${v[0]}, ${v[1]}]`);
        }
      }
    }
  }
  lines.push('');

  lines.push('forbidden:');
  if (ctx.forbidden.length === 0) {
    lines.push('  []');
  } else {
    for (const f of ctx.forbidden) {
      lines.push(`  - ${yamlString(f)}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Safely quote a string for the YAML subset. Always uses double
 * quotes when in doubt. Null-safe (undefined → empty string).
 */
function yamlString(s: string | null | undefined): string {
  if (s == null) return '""';
  const str = String(s);
  // Empty
  if (str === '') return '""';
  // Needs quoting if contains : # " ' [ ] { } , | > * & ! % @ `
  // or leading/trailing whitespace, or starts with `-`, or is a reserved word
  const reserved = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']);
  const needsQuote =
    reserved.has(str.toLowerCase()) ||
    /^-?\d+(\.\d+)?$/.test(str) ||
    /[:#"'[\]{},|>*&!%@`]/.test(str) ||
    /^\s|\s$/.test(str) ||
    /^[-?,\[\]{}#&*!|>'"%@`]/.test(str) ||
    str.includes('\n');
  if (!needsQuote) return str;
  // Escape backslashes + double quotes + newlines
  const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

// ── Context summary (for CLI display) ──

export interface ContextSummary {
  project_name: string;
  project_domain: string;
  flow_count: number;
  invariant_count: number;
  model_contract_count: number;
  forbidden_count: number;
  flows: Array<{
    id: string;
    name: string;
    invariant_count: number;
    invariants: Array<{ id: string; description: string; severity: InvariantSeverity }>;
  }>;
  source: BusinessContext['source'];
}

/**
 * Build a human-readable summary of a context suitable for the CLI
 * pre-scan confirmation step.
 */
export function summarizeContext(ctx: BusinessContext): ContextSummary {
  const flows = ctx.critical_flows.map((f) => ({
    id: f.id,
    name: f.name,
    invariant_count: f.invariants.length,
    invariants: f.invariants.map((i) => ({
      id: i.id,
      description: i.description,
      severity: i.severity,
    })),
  }));
  const totalInvariants = ctx.critical_flows.reduce((a, f) => a + f.invariants.length, 0);
  return {
    project_name: ctx.project.name,
    project_domain: ctx.project.domain,
    flow_count: ctx.critical_flows.length,
    invariant_count: totalInvariants,
    model_contract_count: ctx.model_contracts.length,
    forbidden_count: ctx.forbidden.length,
    flows,
    source: ctx.source,
  };
}
