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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CIRawConfig } from './ci_extract.js';
import type { RepoProfile } from './profile.js';
import { invokeLLMWithFallback, type Provider } from './llm_provider.js';

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
  source: 'context.yml' | 'context.json' | 'auto_extracted' | 'empty';
}

export const EMPTY_CONTEXT: BusinessContext = {
  project: { name: '', domain: '', summary: '' },
  critical_flows: [],
  model_contracts: [],
  forbidden: [],
  source: 'empty',
};

// ── Entrypoint ──

/**
 * Load business context for a cloned repo. Tries the three sources in
 * order. If `llmInvoker` is provided and no file-based source yields
 * a context, falls back to an LLM-based auto-extract from README +
 * OpenAPI. Never throws — returns EMPTY_CONTEXT on total failure.
 */
export async function loadBusinessContext(
  repoDir: string,
  opts?: {
    provider?: Provider;
    allowAutoExtract?: boolean;
  }
): Promise<BusinessContext> {
  const yml = join(repoDir, '.edward', 'context.yml');
  const yaml = join(repoDir, '.edward', 'context.yaml');
  const jsonPath = join(repoDir, '.edward', 'context.json');

  for (const p of [yml, yaml]) {
    if (safeExists(p)) {
      try {
        const text = readFileSync(p, 'utf-8');
        return parseContextYaml(text);
      } catch (err: any) {
        console.error(`[edward] .edward/context.yml parse failed: ${err?.message || err}`);
        // fall through to JSON / auto-extract
      }
    }
  }

  if (safeExists(jsonPath)) {
    try {
      const text = readFileSync(jsonPath, 'utf-8');
      const raw = JSON.parse(text);
      return normalizeContext(raw, 'context.json');
    } catch (err: any) {
      console.error(`[edward] .edward/context.json parse failed: ${err?.message || err}`);
    }
  }

  if (opts?.allowAutoExtract) {
    try {
      return await autoExtractContext(repoDir, opts.provider);
    } catch (err: any) {
      console.error(`[edward] auto-extract business context failed: ${err?.message || err}`);
    }
  }

  return { ...EMPTY_CONTEXT };
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
 * LLM-assisted auto-extraction of business context from a repo's
 * existing files. Inputs we look at, in order of trust:
 *
 *   1. OpenAPI / Swagger / JSON Schema files at repo root
 *   2. README.md / README.* at repo root
 *   3. docs/*.md (first ~100KB collected)
 *
 * The LLM call asks: "given these docs, emit a BusinessContext JSON
 * following this exact schema". We use a single LLM call with a
 * tight prompt and strict JSON output. Falls back to EMPTY_CONTEXT
 * if the call fails or the output can't be coerced.
 *
 * This is deliberately conservative: auto-extract should produce a
 * reasonable ~60% starting point for teams that haven't written
 * `.edward/context.yml` yet, not a gold-standard replacement.
 */
export async function autoExtractContext(
  repoDir: string,
  provider?: Provider
): Promise<BusinessContext> {
  const sources = gatherAutoExtractSources(repoDir);
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
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      timeoutMs: 180_000,
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
  totalBytes: number;
}

function gatherAutoExtractSources(repoDir: string): AutoExtractSources {
  const result: AutoExtractSources = {
    openapi: [],
    readme: null,
    docs: [],
    totalBytes: 0,
  };

  // OpenAPI / Swagger candidates
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

  // README
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

  // docs/*.md — first 5 files, 20KB each, 100KB cap total
  const docsDir = join(repoDir, 'docs');
  if (safeExists(docsDir)) {
    try {
      const { readdirSync, statSync } = require('node:fs');
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

  return result;
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
- Only emit critical_flows you can concretely identify from the docs.
  Do NOT invent flows to look thorough.
- For each flow, emit 1-5 invariants drawn from explicit rules in the
  docs ("X must happen within 60 seconds", "user Y cannot access Z",
  "rate limit is 100/min"). If the docs don't spell out rules for a
  flow, emit fewer invariants rather than making them up.
- entry_points can be rough — file paths or route patterns are both
  fine. They're used as fuzzy hints, not as exact matches.
- model_contracts only applies if the project calls an LLM API. Skip
  otherwise (empty array).
- forbidden captures "this must NEVER be true" rules.

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
