/**
 * Feature Inventory — deterministic enumeration of "business features"
 * present in a repo's source tree. This is the input to the Functional
 * CI Gap Analysis phase: Edward needs to know "what discrete units of
 * behavior does this project expose" before it can ask "which of them
 * have no CI test".
 *
 * What counts as a feature:
 *
 *   1. HTTP endpoints — handlers registered with a web framework
 *      (FastAPI, Flask, Express, Nest, Koa, Spring, Gin, Echo,
 *       Axum, Actix, Rails, Sinatra, Laravel, Slim, ASP.NET)
 *   2. LLM calls — callsites to OpenAI / Anthropic / Bedrock / Cohere /
 *      Mistral / Gemini SDKs (because the business_context layer
 *      may declare model contracts on these)
 *   3. Scheduled jobs — cron / Celery task / BullMQ / sidekiq / rq /
 *      node-cron / scheduled workflow handlers
 *   4. Message queue consumers — @kafka / @rabbit / @sqs / amqp
 *
 * Matching is regex-based. We deliberately avoid AST parsing because
 * (a) it would require a parser per language, (b) false positives are
 * cheap at this stage (they'd be filtered later by the test-mapping
 * layer), (c) we only need rough file/line pointers.
 *
 * IMPORTANT: nothing in this file is project-specific. Every regex is
 * against a public framework convention. The same scanner applies to
 * ama-user-service, clawschool, kubernetes, or any other repo.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepoProfile } from './profile.js';

// ── Public types ──

export type FeatureKind =
  | 'http_endpoint'
  | 'llm_call'
  | 'cron_job'
  | 'queue_consumer';

export interface Feature {
  /** Stable-ish id for this feature. Not a random UUID — derived from file+line+kind so the same scan produces the same ids. */
  id: string;
  kind: FeatureKind;
  /** repo-relative path */
  file: string;
  /** 1-indexed line number where the match started */
  line: number;
  /** Framework / library that produced this match (e.g. 'fastapi', 'express', 'openai'). */
  framework: string;
  /** Language of the file ('python', 'typescript', etc.). */
  language: string;
  /** Human-readable label. For endpoints: `METHOD path`. For llm calls: `library.method`. For cron: `schedule`. */
  label: string;
  /** Extra framework-specific attributes (e.g. handler function name, path parameters). */
  meta: Record<string, string>;
}

export interface FeatureSurface {
  endpoints: Feature[];
  llm_calls: Feature[];
  cron_jobs: Feature[];
  queue_consumers: Feature[];
  /** Total source files scanned. */
  files_scanned: number;
  /** Files that produced at least one match. */
  files_matched: number;
}

// ── Source file enumeration ──

const SOURCE_EXTS = new Set([
  'py', 'pyi',
  'ts', 'tsx', 'mts', 'cts',
  'js', 'jsx', 'mjs', 'cjs',
  'go',
  'rs',
  'java', 'kt',
  'rb',
  'php',
  'cs',
]);

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'out',
  '__pycache__', '.venv', 'venv', 'env', 'envs',
  '.next', '.nuxt', '.cache', '.idea', '.vscode',
  'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.gradle', '.m2',
]);

const EXT_TO_LANG: Record<string, string> = {
  py: 'python', pyi: 'python',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  go: 'go',
  rs: 'rust',
  java: 'java', kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
};

interface SourceFile {
  relPath: string;
  absPath: string;
  ext: string;
  language: string;
  size: number;
}

function enumerateSources(repoDir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }
    for (const name of entries) {
      if (IGNORE_DIRS.has(name)) continue;
      if (name.startsWith('.') && name !== '.github') continue;
      const full = join(abs, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      const relPath = rel ? `${rel}/${name}` : name;
      if (s.isDirectory()) { walk(full, relPath); continue; }
      if (!s.isFile()) continue;
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) continue;
      if (s.size > 1_500_000) continue; // skip huge files
      out.push({
        relPath,
        absPath: full,
        ext,
        language: EXT_TO_LANG[ext] || 'unknown',
        size: s.size,
      });
    }
  };
  walk(repoDir, '');
  return out;
}

// ── Regex rulebook ──
//
// Each rule says: "if the content of a <language> file matches <regex>,
// emit a <kind> feature with these meta fields".
//
// Pattern notes:
//   - We use multiline regex (`m` flag) and scan the full content
//   - Capture group 1 = primary label content (e.g. route path)
//   - Capture group 2 = secondary (e.g. handler name) where applicable
//   - Framework id lives in the rule record

interface MatchRule {
  framework: string;
  kind: FeatureKind;
  /** Regex applied to file content. `gm` flags recommended. */
  pattern: RegExp;
  /** Build a label from the regex match. */
  label: (m: RegExpMatchArray, lang: string) => string;
  /** Build meta from the regex match. */
  meta?: (m: RegExpMatchArray) => Record<string, string>;
}

const HTTP_METHOD = '(get|post|put|patch|delete|head|options|route|handle|any)';

const PYTHON_RULES: MatchRule[] = [
  // FastAPI / Starlette
  {
    framework: 'fastapi',
    kind: 'http_endpoint',
    pattern: /@(?:\w+\.)?(?:app|router|api)\.(get|post|put|patch|delete|head|options|websocket)\s*\(\s*["']([^"']+)["']/gmi,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // Flask
  {
    framework: 'flask',
    kind: 'http_endpoint',
    pattern: /@(?:\w+\.)?(?:app|bp|blueprint)\.(?:route|get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gmi,
    label: (m) => `ROUTE ${m[1]}`,
    meta: (m) => ({ path: m[1] }),
  },
  // Django urls
  {
    framework: 'django',
    kind: 'http_endpoint',
    pattern: /path\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_][A-Za-z0-9_.]*)/gm,
    label: (m) => `URL ${m[1]} → ${m[2]}`,
    meta: (m) => ({ path: m[1], handler: m[2] }),
  },
  // OpenAI python SDK
  {
    framework: 'openai',
    kind: 'llm_call',
    pattern: /\b(?:openai|OpenAI\(\))\.\s*(?:ChatCompletion|completions|chat\.completions|embeddings|images|audio)\.create\s*\(/gm,
    label: () => 'openai.create',
  },
  {
    framework: 'openai',
    kind: 'llm_call',
    pattern: /\bclient\.chat\.completions\.create\s*\(/gm,
    label: () => 'openai chat.completions.create',
  },
  // Anthropic python SDK
  {
    framework: 'anthropic',
    kind: 'llm_call',
    pattern: /\b(?:anthropic|Anthropic\(\))\.messages\.create\s*\(/gm,
    label: () => 'anthropic.messages.create',
  },
  {
    framework: 'anthropic',
    kind: 'llm_call',
    pattern: /\bclient\.messages\.create\s*\(/gm,
    label: () => 'anthropic client.messages.create',
  },
  // Google Gemini
  {
    framework: 'google-genai',
    kind: 'llm_call',
    pattern: /\bgenai\.GenerativeModel\s*\(/gm,
    label: () => 'google genai.GenerativeModel',
  },
  // Celery tasks
  {
    framework: 'celery',
    kind: 'queue_consumer',
    pattern: /@(?:\w+\.)?(?:app|celery)\.task\b/gm,
    label: () => 'celery task',
  },
  // APScheduler / schedule library
  {
    framework: 'apscheduler',
    kind: 'cron_job',
    pattern: /@(?:\w+\.)?scheduler\.scheduled_job\s*\(/gm,
    label: () => 'apscheduler scheduled_job',
  },
  // rq
  {
    framework: 'rq',
    kind: 'queue_consumer',
    pattern: /\bQueue\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `rq queue ${m[1]}`,
  },
];

const JS_RULES: MatchRule[] = [
  // Express
  {
    framework: 'express',
    kind: 'http_endpoint',
    pattern: /\b(?:app|router)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // Koa / koa-router
  {
    framework: 'koa-router',
    kind: 'http_endpoint',
    pattern: /\brouter\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // NestJS decorators
  {
    framework: 'nestjs',
    kind: 'http_endpoint',
    pattern: /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:["']([^"']*)["'])?\s*\)/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2] || '/'}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] || '/' }),
  },
  // Next.js / Remix / SvelteKit: file-based, no regex — Day 2 could add filename-based detection
  // Fastify
  {
    framework: 'fastify',
    kind: 'http_endpoint',
    pattern: /\bfastify\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // OpenAI JS SDK
  {
    framework: 'openai',
    kind: 'llm_call',
    pattern: /\b(?:openai|client)\.chat\.completions\.create\s*\(/gm,
    label: () => 'openai chat.completions.create',
  },
  {
    framework: 'openai',
    kind: 'llm_call',
    pattern: /\bnew\s+OpenAI\s*\(/gm,
    label: () => 'new OpenAI()',
  },
  // Anthropic JS SDK
  {
    framework: 'anthropic',
    kind: 'llm_call',
    pattern: /\b(?:anthropic|client)\.messages\.create\s*\(/gm,
    label: () => 'anthropic messages.create',
  },
  {
    framework: 'anthropic',
    kind: 'llm_call',
    pattern: /\bnew\s+Anthropic\s*\(/gm,
    label: () => 'new Anthropic()',
  },
  // BullMQ / Bull
  {
    framework: 'bullmq',
    kind: 'queue_consumer',
    pattern: /\bnew\s+(?:Worker|Queue)\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `bullmq ${m[1]}`,
  },
  // node-cron
  {
    framework: 'node-cron',
    kind: 'cron_job',
    pattern: /\bcron\.schedule\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `cron ${m[1]}`,
  },
];

const GO_RULES: MatchRule[] = [
  // net/http
  {
    framework: 'net/http',
    kind: 'http_endpoint',
    pattern: /\bhttp\.HandleFunc\s*\(\s*"([^"]+)"/gm,
    label: (m) => `HANDLE ${m[1]}`,
    meta: (m) => ({ path: m[1] }),
  },
  // chi / gin / echo / fiber
  {
    framework: 'chi|gin|echo|fiber',
    kind: 'http_endpoint',
    pattern: /\b[A-Za-z_][A-Za-z0-9_]*\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Handle)\s*\(\s*"([^"]+)"/gm,
    label: (m) => `${m[1]} ${m[2]}`,
    meta: (m) => ({ method: m[1], path: m[2] }),
  },
  // Cron
  {
    framework: 'robfig/cron',
    kind: 'cron_job',
    pattern: /\b[cC]ron\.AddFunc\s*\(\s*"([^"]+)"/gm,
    label: (m) => `cron ${m[1]}`,
  },
];

const RUST_RULES: MatchRule[] = [
  // actix-web
  {
    framework: 'actix-web',
    kind: 'http_endpoint',
    pattern: /#\[(get|post|put|patch|delete|head)\s*\(\s*"([^"]+)"\s*\)\]/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // axum
  {
    framework: 'axum',
    kind: 'http_endpoint',
    pattern: /\bRouter::new\s*\(\s*\)[\s\S]{0,400}?\.route\s*\(\s*"([^"]+)"/gm,
    label: (m) => `ROUTE ${m[1]}`,
    meta: (m) => ({ path: m[1] }),
  },
];

const JAVA_RULES: MatchRule[] = [
  // Spring MVC
  {
    framework: 'spring',
    kind: 'http_endpoint',
    pattern: /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*(?:"([^"]*)"|value\s*=\s*"([^"]*)")/gm,
    label: (m) => `${m[1].replace('Mapping', '').toUpperCase()} ${m[2] || m[3] || '/'}`,
    meta: (m) => ({ method: m[1], path: m[2] || m[3] || '/' }),
  },
  // Scheduled
  {
    framework: 'spring',
    kind: 'cron_job',
    pattern: /@Scheduled\s*\([^)]*\)/gm,
    label: () => 'spring @Scheduled',
  },
];

const RUBY_RULES: MatchRule[] = [
  // Rails routes
  {
    framework: 'rails',
    kind: 'http_endpoint',
    pattern: /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // Sidekiq
  {
    framework: 'sidekiq',
    kind: 'queue_consumer',
    pattern: /\binclude\s+Sidekiq::Worker\b/gm,
    label: () => 'sidekiq worker',
  },
];

const PHP_RULES: MatchRule[] = [
  // Laravel
  {
    framework: 'laravel',
    kind: 'http_endpoint',
    pattern: /Route::(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gm,
    label: (m) => `${m[1].toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
];

const CS_RULES: MatchRule[] = [
  // ASP.NET attribute routing
  {
    framework: 'aspnet',
    kind: 'http_endpoint',
    pattern: /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\s*\(\s*"([^"]+)"\s*\)\]/gm,
    label: (m) => `${m[1].replace('Http', '').toUpperCase()} ${m[2]}`,
    meta: (m) => ({ method: m[1].replace('Http', '').toUpperCase(), path: m[2] }),
  },
];

const RULES_BY_LANG: Record<string, MatchRule[]> = {
  python: PYTHON_RULES,
  typescript: JS_RULES,
  javascript: JS_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  java: JAVA_RULES,
  kotlin: JAVA_RULES,
  ruby: RUBY_RULES,
  php: PHP_RULES,
  csharp: CS_RULES,
};

// Acknowledge the silenced HTTP_METHOD constant so lint stays clean.
void HTTP_METHOD;

// ── Scanner ──

/**
 * Walk the source tree and build a FeatureSurface by applying each
 * language's rules to each file's text. File I/O is capped per-file
 * at 1.5MB (enforced in `enumerateSources`); content is scanned once
 * against all rules for the file's language.
 */
export function enumerateFeatures(
  repoDir: string,
  _profile?: RepoProfile
): FeatureSurface {
  const files = enumerateSources(repoDir);
  const surface: FeatureSurface = {
    endpoints: [],
    llm_calls: [],
    cron_jobs: [],
    queue_consumers: [],
    files_scanned: files.length,
    files_matched: 0,
  };

  for (const f of files) {
    const rules = RULES_BY_LANG[f.language] || [];
    if (rules.length === 0) continue;
    let content: string;
    try {
      content = readFileSync(f.absPath, 'utf-8');
      if (content.indexOf('\0') !== -1) continue; // binary
    } catch { continue; }

    let matched = false;
    for (const rule of rules) {
      // fresh exec state every rule
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(content)) !== null) {
        // Guard against zero-width matches
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
        const line = lineOf(content, m.index);
        const label = safeCall(() => rule.label(m!, f.language), '(unlabeled)');
        const meta = rule.meta ? safeCall(() => rule.meta!(m!), {} as Record<string, string>) : {};
        const feature: Feature = {
          id: `${rule.kind}:${f.relPath}:${line}:${rule.framework}`,
          kind: rule.kind,
          file: f.relPath,
          line,
          framework: rule.framework,
          language: f.language,
          label,
          meta,
        };
        bucketFor(surface, rule.kind).push(feature);
        matched = true;
      }
    }
    if (matched) surface.files_matched++;
  }

  // De-dup by id (same framework scanning file twice shouldn't double-count)
  surface.endpoints = dedupById(surface.endpoints);
  surface.llm_calls = dedupById(surface.llm_calls);
  surface.cron_jobs = dedupById(surface.cron_jobs);
  surface.queue_consumers = dedupById(surface.queue_consumers);

  return surface;
}

function bucketFor(surface: FeatureSurface, kind: FeatureKind): Feature[] {
  switch (kind) {
    case 'http_endpoint': return surface.endpoints;
    case 'llm_call': return surface.llm_calls;
    case 'cron_job': return surface.cron_jobs;
    case 'queue_consumer': return surface.queue_consumers;
  }
}

function dedupById(list: Feature[]): Feature[] {
  const seen = new Set<string>();
  const out: Feature[] = [];
  for (const f of list) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

// Silence unused export warnings from ts lint by touching relative (we use it indirectly in comments only).
void relative;

// ── Summary helpers for prompts ──

/**
 * Trim FeatureSurface down to a prompt-safe shape. Caps the number of
 * each feature kind to avoid blowing past LLM context on huge
 * codebases.
 */
export function surfaceForPrompt(
  s: FeatureSurface,
  opts?: { maxPerKind?: number }
): any {
  const cap = opts?.maxPerKind ?? 40;
  const trim = (list: Feature[]) => list.slice(0, cap).map((f) => ({
    id: f.id,
    kind: f.kind,
    file: f.file,
    line: f.line,
    framework: f.framework,
    language: f.language,
    label: f.label,
    ...(Object.keys(f.meta).length > 0 ? { meta: f.meta } : {}),
  }));
  return {
    endpoints: trim(s.endpoints),
    endpoints_total: s.endpoints.length,
    llm_calls: trim(s.llm_calls),
    llm_calls_total: s.llm_calls.length,
    cron_jobs: trim(s.cron_jobs),
    cron_jobs_total: s.cron_jobs.length,
    queue_consumers: trim(s.queue_consumers),
    queue_consumers_total: s.queue_consumers.length,
    files_scanned: s.files_scanned,
    files_matched: s.files_matched,
  };
}
