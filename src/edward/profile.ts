/**
 * RepoProfile — fast file-system probe of a target repo.
 *
 * Layer 1 of the CI completeness audit. Produces a structured snapshot
 * of "what kind of repo is this" by reading well-known files only.
 * No LLM calls, no network, no parsing of source code. Should run in
 * well under one second on any reasonably-sized repo.
 *
 * The output is consumed by Phase 0 of ANALYSIS_PROMPT (in server.ts)
 * to give the `claude` subprocess the structured facts it needs to
 * judge whether the repo's CI is appropriate for this kind of project.
 *
 * Detection strategy: rules first. Every probe is a single file
 * existence check or a small JSON / TOML field read. Unknown stacks
 * fall through to `unknown` and Phase 0 prompt asks the model to
 * fill in the blanks from README and directory listing.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Public types ──

export interface RepoProfile {
  topology: 'monolith' | 'monorepo' | 'unknown';
  workspaces: string[];

  roles: RepoRole[];
  stacks: TechStack[];
  packageManagers: PackageManager[];

  hasTests: boolean;
  testDirs: string[];
  hasDockerfile: boolean;
  hasComposeFile: boolean;
  hasIaC: boolean;
  hasDeployConfig: boolean;
  hasReadme: boolean;

  detectedScripts: {
    install?: string;
    build?: string;
    test?: string;
    lint?: string;
    typecheck?: string;
    start?: string;
  };
}

export type RepoRole =
  | 'frontend' | 'backend' | 'cli' | 'library' | 'mobile' | 'iac' | 'docs';

export type TechStack =
  | 'node' | 'python' | 'go' | 'rust' | 'java'
  | 'docker' | 'terraform' | 'unknown';

export type PackageManager =
  | 'npm' | 'yarn' | 'pnpm' | 'bun'
  | 'pip' | 'poetry' | 'uv' | 'cargo' | 'go_mod';

// ── Safe file helpers — never throw on permission denied / symlink loops ──

function safeExists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}

function safeReadText(path: string, maxBytes = 1_000_000): string | null {
  try {
    const s = safeStat(path);
    if (!s || !s.isFile() || s.size > maxBytes) return null;
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

function safeReadJson<T = any>(path: string): T | null {
  const text = safeReadText(path);
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

function safeReadDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

// ── Topology detection ──

function detectTopology(repoDir: string): { topology: RepoProfile['topology']; workspaces: string[] } {
  // pnpm workspace
  if (safeExists(join(repoDir, 'pnpm-workspace.yaml'))) {
    return {
      topology: 'monorepo',
      workspaces: parseWorkspacesFromYaml(safeReadText(join(repoDir, 'pnpm-workspace.yaml')) || ''),
    };
  }
  // package.json workspaces field
  const pkg = safeReadJson<{ workspaces?: string[] | { packages?: string[] } }>(
    join(repoDir, 'package.json')
  );
  if (pkg?.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
    return { topology: 'monorepo', workspaces: ws };
  }
  // turbo / lerna / nx
  if (safeExists(join(repoDir, 'turbo.json')) ||
      safeExists(join(repoDir, 'lerna.json')) ||
      safeExists(join(repoDir, 'nx.json'))) {
    return { topology: 'monorepo', workspaces: [] };
  }
  // cargo workspace
  const cargoToml = safeReadText(join(repoDir, 'Cargo.toml'));
  if (cargoToml && /^\[workspace\]/m.test(cargoToml)) {
    return { topology: 'monorepo', workspaces: [] };
  }
  // top-level packages/ or apps/ dirs as a hint (only if there's also a project file)
  const topLevel = safeReadDir(repoDir);
  if ((topLevel.includes('packages') || topLevel.includes('apps')) && pkg) {
    return { topology: 'monorepo', workspaces: [] };
  }
  // Has any project file? → monolith. Otherwise unknown.
  if (pkg ||
      safeExists(join(repoDir, 'pyproject.toml')) ||
      safeExists(join(repoDir, 'Cargo.toml')) ||
      safeExists(join(repoDir, 'go.mod')) ||
      safeExists(join(repoDir, 'requirements.txt'))) {
    return { topology: 'monolith', workspaces: [] };
  }
  return { topology: 'unknown', workspaces: [] };
}

// Crude pnpm-workspace.yaml parser — just grabs lines starting with `-`
function parseWorkspacesFromYaml(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^-\s*['"]?([^'"]+?)['"]?$/);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

// ── Stack detection ──

function detectStacks(repoDir: string): TechStack[] {
  const stacks = new Set<TechStack>();
  if (safeExists(join(repoDir, 'package.json'))) stacks.add('node');
  if (safeExists(join(repoDir, 'pyproject.toml')) ||
      safeExists(join(repoDir, 'requirements.txt')) ||
      safeExists(join(repoDir, 'setup.py')) ||
      safeExists(join(repoDir, 'Pipfile'))) stacks.add('python');
  if (safeExists(join(repoDir, 'go.mod'))) stacks.add('go');
  if (safeExists(join(repoDir, 'Cargo.toml'))) stacks.add('rust');
  if (safeExists(join(repoDir, 'pom.xml')) ||
      safeExists(join(repoDir, 'build.gradle')) ||
      safeExists(join(repoDir, 'build.gradle.kts'))) stacks.add('java');
  if (safeExists(join(repoDir, 'Dockerfile')) ||
      safeExists(join(repoDir, 'docker-compose.yml')) ||
      safeExists(join(repoDir, 'docker-compose.yaml')) ||
      safeExists(join(repoDir, 'compose.yml'))) stacks.add('docker');
  // Terraform: any *.tf at the top level
  if (safeReadDir(repoDir).some(f => f.endsWith('.tf'))) stacks.add('terraform');

  if (stacks.size === 0) stacks.add('unknown');
  return [...stacks];
}

// ── Package manager detection ──

function detectPackageManagers(repoDir: string): PackageManager[] {
  const pms = new Set<PackageManager>();

  // Lockfile presence is the primary signal
  if (safeExists(join(repoDir, 'package-lock.json'))) pms.add('npm');
  if (safeExists(join(repoDir, 'yarn.lock'))) pms.add('yarn');
  if (safeExists(join(repoDir, 'pnpm-lock.yaml'))) pms.add('pnpm');
  if (safeExists(join(repoDir, 'bun.lockb')) || safeExists(join(repoDir, 'bun.lock'))) pms.add('bun');
  if (safeExists(join(repoDir, 'requirements.txt')) ||
      safeExists(join(repoDir, 'requirements-dev.txt'))) pms.add('pip');
  if (safeExists(join(repoDir, 'poetry.lock'))) pms.add('poetry');
  if (safeExists(join(repoDir, 'uv.lock'))) pms.add('uv');
  if (safeExists(join(repoDir, 'Cargo.lock'))) pms.add('cargo');
  if (safeExists(join(repoDir, 'go.sum'))) pms.add('go_mod');

  // Fallback: package.json packageManager / engines fields when no lockfile
  // (zero-dep / lockless projects still tell us what they want via these)
  if (pms.size === 0 || (!pms.has('npm') && !pms.has('yarn') && !pms.has('pnpm') && !pms.has('bun'))) {
    const pkg = safeReadJson<any>(join(repoDir, 'package.json'));
    if (pkg) {
      const pmField: string = pkg.packageManager || '';
      if (pmField.startsWith('pnpm')) pms.add('pnpm');
      else if (pmField.startsWith('yarn')) pms.add('yarn');
      else if (pmField.startsWith('bun')) pms.add('bun');
      else if (pmField.startsWith('npm')) pms.add('npm');

      const engines = pkg.engines || {};
      if (!pms.has('bun') && engines.bun) pms.add('bun');
      if (!pms.has('pnpm') && engines.pnpm) pms.add('pnpm');
      if (!pms.has('yarn') && engines.yarn) pms.add('yarn');
    }
  }

  return [...pms];
}

// ── Role detection ──

const FRONTEND_DEPS = new Set([
  'react', 'next', 'vue', '@angular/core', 'svelte', 'sveltekit',
  'solid-js', 'astro', 'nuxt', 'preact', 'qwik', 'remix', '@remix-run/react',
]);
const BACKEND_DEPS = new Set([
  'express', 'fastify', 'koa', 'hapi', '@nestjs/core', 'hono',
]);
const MOBILE_DEPS = new Set([
  'react-native', 'expo', '@ionic/angular', '@ionic/react',
  '@capacitor/core',
]);

function depsOf(pkg: any): string[] {
  if (!pkg || typeof pkg !== 'object') return [];
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ];
}

function detectRoles(repoDir: string, stacks: TechStack[]): RepoRole[] {
  const roles = new Set<RepoRole>();

  const pkg = safeReadJson<any>(join(repoDir, 'package.json'));
  const deps = depsOf(pkg);

  // Frontend
  if (deps.some(d => FRONTEND_DEPS.has(d)) ||
      safeExists(join(repoDir, 'next.config.js')) ||
      safeExists(join(repoDir, 'next.config.ts')) ||
      safeExists(join(repoDir, 'next.config.mjs')) ||
      safeExists(join(repoDir, 'vite.config.js')) ||
      safeExists(join(repoDir, 'vite.config.ts')) ||
      safeExists(join(repoDir, 'svelte.config.js')) ||
      safeExists(join(repoDir, 'astro.config.mjs')) ||
      safeExists(join(repoDir, 'nuxt.config.js')) ||
      safeExists(join(repoDir, 'nuxt.config.ts'))) {
    roles.add('frontend');
  }

  // Mobile
  if (deps.some(d => MOBILE_DEPS.has(d))) {
    roles.add('mobile');
  }

  // Backend (Node)
  if (deps.some(d => BACKEND_DEPS.has(d))) {
    roles.add('backend');
  }
  // Backend (Python)
  const reqs = safeReadText(join(repoDir, 'requirements.txt')) || '';
  if (/(?:^|\n)\s*(flask|fastapi|django|starlette|aiohttp|tornado|sanic)\b/i.test(reqs)) {
    roles.add('backend');
  }
  const pyproject = safeReadText(join(repoDir, 'pyproject.toml')) || '';
  if (/(flask|fastapi|django|starlette|sanic)\s*=/i.test(pyproject)) {
    roles.add('backend');
  }
  // Backend (Go) — quick heuristic on main.go
  if (stacks.includes('go') && safeExists(join(repoDir, 'main.go'))) {
    const goMain = safeReadText(join(repoDir, 'main.go')) || '';
    if (/(net\/http|gin-gonic|labstack\/echo|gofiber|go-chi)/i.test(goMain)) {
      roles.add('backend');
    }
  }
  // Backend (Rust)
  const cargoToml = safeReadText(join(repoDir, 'Cargo.toml')) || '';
  if (/(actix-web|rocket|axum|tide|warp)\s*=/i.test(cargoToml)) {
    roles.add('backend');
  }

  // CLI
  if (pkg?.bin || /\[\[bin\]\]/.test(cargoToml)) {
    roles.add('cli');
  }
  if (/console_scripts|\[project\.scripts\]|\[tool\.poetry\.scripts\]/.test(pyproject)) {
    roles.add('cli');
  }

  // Library — has main/exports but no bin and no server-y role
  if (pkg && (pkg.main || pkg.exports || pkg.module) && !pkg.bin &&
      !roles.has('frontend') && !roles.has('backend') && !roles.has('mobile')) {
    roles.add('library');
  }

  // IaC
  if (stacks.includes('terraform') ||
      safeExists(join(repoDir, 'Pulumi.yaml')) ||
      safeExists(join(repoDir, 'cdk.json')) ||
      safeExists(join(repoDir, 'serverless.yml'))) {
    roles.add('iac');
  }

  // Docs — only if nothing else matched and there's a clear docs structure
  if (roles.size === 0) {
    if (safeExists(join(repoDir, 'mkdocs.yml')) ||
        safeExists(join(repoDir, 'docusaurus.config.js')) ||
        safeExists(join(repoDir, 'docusaurus.config.ts'))) {
      roles.add('docs');
    }
  }

  return [...roles];
}

// ── Test directory detection ──

const TEST_DIR_NAMES = ['tests', '__tests__', 'spec', 'test', 'e2e', 'cypress', 'integration_tests'];

function detectTestDirs(repoDir: string): string[] {
  const found: string[] = [];
  const top = safeReadDir(repoDir);
  for (const name of TEST_DIR_NAMES) {
    if (top.includes(name)) {
      const s = safeStat(join(repoDir, name));
      if (s && s.isDirectory()) found.push(name);
    }
  }
  return found;
}

// ── Deploy / IaC config presence ──

const DEPLOY_FILES = [
  'vercel.json', 'netlify.toml', 'fly.toml', 'render.yaml',
  'app.yaml', 'Procfile', 'wrangler.toml',
];

const IAC_TOP_FILES = [
  'Pulumi.yaml', 'cdk.json', 'serverless.yml', 'sam-template.yaml',
];

function detectDeployConfig(repoDir: string): boolean {
  return DEPLOY_FILES.some(f => safeExists(join(repoDir, f)));
}

function detectIaC(repoDir: string): boolean {
  if (IAC_TOP_FILES.some(f => safeExists(join(repoDir, f)))) return true;
  return safeReadDir(repoDir).some(f => f.endsWith('.tf'));
}

// ── Detected scripts ──

function detectScripts(repoDir: string, packageManagers: PackageManager[]): RepoProfile['detectedScripts'] {
  const out: RepoProfile['detectedScripts'] = {};

  // Pick the right Node-ecosystem runner based on detected package manager.
  // Default to npm when no Node PM detected (matches the most common case).
  const nodeRunner =
    packageManagers.includes('bun') ? 'bun' :
    packageManagers.includes('pnpm') ? 'pnpm' :
    packageManagers.includes('yarn') ? 'yarn' :
    'npm';
  const nodeInstallCmd =
    nodeRunner === 'bun' ? 'bun install' :
    nodeRunner === 'pnpm' ? 'pnpm install --frozen-lockfile' :
    nodeRunner === 'yarn' ? 'yarn install --frozen-lockfile' :
    'npm ci';
  const nodeRunPrefix =
    nodeRunner === 'npm' ? 'npm run' :
    nodeRunner === 'yarn' ? 'yarn' :
    `${nodeRunner} run`;

  // package.json scripts
  const pkg = safeReadJson<{ scripts?: Record<string, string> }>(
    join(repoDir, 'package.json')
  );
  const scripts = pkg?.scripts || {};
  if (scripts.test) out.test = `${nodeRunPrefix} test`;
  if (scripts.build) out.build = `${nodeRunPrefix} build`;
  if (scripts.lint) out.lint = `${nodeRunPrefix} lint`;
  if (scripts.typecheck || scripts['type-check']) out.typecheck = `${nodeRunPrefix} typecheck`;
  if (scripts.start) out.start = `${nodeRunPrefix} start`;
  if (scripts.dev && !out.start) out.start = `${nodeRunPrefix} dev`;
  if (pkg) out.install = nodeInstallCmd;

  // Python
  const hasPythonStack =
    safeExists(join(repoDir, 'requirements.txt')) ||
    safeExists(join(repoDir, 'pyproject.toml')) ||
    safeExists(join(repoDir, 'setup.py')) ||
    safeExists(join(repoDir, 'Pipfile'));
  if (safeExists(join(repoDir, 'requirements.txt'))) {
    out.install ??= 'pip install -r requirements.txt';
  }
  if (safeExists(join(repoDir, 'pyproject.toml'))) {
    const pyproject = safeReadText(join(repoDir, 'pyproject.toml')) || '';
    if (/\[tool\.poetry\]/.test(pyproject)) {
      out.install = 'poetry install';
    } else if (/\[tool\.uv\]/.test(pyproject)) {
      out.install = 'uv sync';
    } else {
      out.install ??= 'pip install -e .';
    }
  }
  // pytest is the de-facto default for any Python project; only set if a
  // tests/ dir is present, otherwise we'd be guessing.
  if (hasPythonStack && !out.test) {
    const hasTestsDir =
      safeExists(join(repoDir, 'tests')) ||
      safeExists(join(repoDir, 'test'));
    if (hasTestsDir) out.test = 'pytest';
  }

  // Go
  if (safeExists(join(repoDir, 'go.mod'))) {
    out.install ??= 'go mod download';
    out.build ??= 'go build ./...';
    out.test ??= 'go test ./...';
  }

  // Rust
  if (safeExists(join(repoDir, 'Cargo.toml'))) {
    out.install ??= 'cargo fetch';
    out.build ??= 'cargo build';
    out.test ??= 'cargo test';
  }

  // Makefile fallbacks (only fill in slots still empty)
  const makefile = safeReadText(join(repoDir, 'Makefile')) || '';
  if (makefile) {
    if (!out.test && /^test:/m.test(makefile)) out.test = 'make test';
    if (!out.build && /^build:/m.test(makefile)) out.build = 'make build';
    if (!out.lint && /^lint:/m.test(makefile)) out.lint = 'make lint';
  }

  return out;
}

// Well-known top-level sub-app directories. Many real-world repos split
// into `frontend/` + `backend/` (or similar) without using a formal
// package-manager workspace. We treat these as implicit monorepos.
const SUB_APP_DIR_NAMES = [
  'frontend', 'backend', 'api', 'web', 'client', 'server',
  'ui', 'service', 'mobile', 'app',
];

function hasProjectFile(dir: string): boolean {
  return safeExists(join(dir, 'package.json')) ||
         safeExists(join(dir, 'pyproject.toml')) ||
         safeExists(join(dir, 'requirements.txt')) ||
         safeExists(join(dir, 'setup.py')) ||
         safeExists(join(dir, 'go.mod')) ||
         safeExists(join(dir, 'Cargo.toml')) ||
         safeExists(join(dir, 'pom.xml')) ||
         safeExists(join(dir, 'build.gradle')) ||
         safeExists(join(dir, 'build.gradle.kts'));
}

function findSubAppDirs(repoDir: string): string[] {
  const top = safeReadDir(repoDir);
  const found: string[] = [];
  for (const name of SUB_APP_DIR_NAMES) {
    if (!top.includes(name)) continue;
    const sub = join(repoDir, name);
    const s = safeStat(sub);
    if (s && s.isDirectory() && hasProjectFile(sub)) {
      found.push(name);
    }
  }
  return found;
}

// ── Main entry ──

export function detectRepoProfile(repoDir: string): RepoProfile {
  // Root scan
  const { topology: rootTopology, workspaces: rootWorkspaces } = detectTopology(repoDir);
  const rootStacks = new Set(detectStacks(repoDir));
  const rootPMs = new Set(detectPackageManagers(repoDir));
  const rootRoles = new Set(detectRoles(repoDir, [...rootStacks]));
  const rootTestDirs = new Set(detectTestDirs(repoDir));
  // "Real" project at root = an actual language manifest, not just
  // infrastructure files like Dockerfile/compose. Used to decide whether
  // sub-app discoveries should override the topology to 'monorepo'.
  const rootHasRealProject = hasProjectFile(repoDir);

  // Implicit-monorepo sub-app scan
  const subApps = findSubAppDirs(repoDir);
  for (const name of subApps) {
    const sub = join(repoDir, name);
    for (const s of detectStacks(sub)) if (s !== 'unknown') rootStacks.add(s);
    for (const pm of detectPackageManagers(sub)) rootPMs.add(pm);
    for (const r of detectRoles(sub, detectStacks(sub))) rootRoles.add(r);
    for (const t of detectTestDirs(sub)) rootTestDirs.add(`${name}/${t}`);
    // Sub-app dir name itself is a strong role hint when no JS framework
    // file matches (e.g. plain Express + flask split)
    if (name === 'frontend' || name === 'web' || name === 'ui' || name === 'client') {
      rootRoles.add('frontend');
    }
    if (name === 'backend' || name === 'api' || name === 'server' || name === 'service') {
      rootRoles.add('backend');
    }
    if (name === 'mobile') rootRoles.add('mobile');
  }

  // If root had no real project file but sub-apps do → implicit monorepo
  let topology = rootTopology;
  let workspaces = rootWorkspaces;
  if (!rootHasRealProject && subApps.length > 0) {
    topology = 'monorepo';
    workspaces = subApps;
  } else if (rootTopology === 'monorepo' && workspaces.length === 0 && subApps.length > 0) {
    // Formal monorepo (turbo / lerna / cargo) where workspaces field was empty:
    // populate from sub-app discovery
    workspaces = subApps;
  }

  // unknown sentinel: only keep if there are truly no other stacks
  if (rootStacks.size > 1) rootStacks.delete('unknown');
  if (rootStacks.size === 0) rootStacks.add('unknown');

  // Scripts: top-level only in Sprint 1. Sub-app scripts are surfaced
  // through workspaces[] and Phase 0 prompt reasons over them.
  const detectedScripts = detectScripts(repoDir, [...rootPMs]);

  return {
    topology,
    workspaces,
    roles: [...rootRoles],
    stacks: [...rootStacks],
    packageManagers: [...rootPMs],
    hasTests: rootTestDirs.size > 0,
    testDirs: [...rootTestDirs],
    hasDockerfile: safeExists(join(repoDir, 'Dockerfile')),
    hasComposeFile: safeExists(join(repoDir, 'docker-compose.yml')) ||
                    safeExists(join(repoDir, 'docker-compose.yaml')) ||
                    safeExists(join(repoDir, 'compose.yml')),
    hasIaC: detectIaC(repoDir),
    hasDeployConfig: detectDeployConfig(repoDir),
    hasReadme: safeExists(join(repoDir, 'README.md')) ||
               safeExists(join(repoDir, 'README.rst')) ||
               safeExists(join(repoDir, 'README.txt')) ||
               safeExists(join(repoDir, 'readme.md')),
    detectedScripts,
  };
}

