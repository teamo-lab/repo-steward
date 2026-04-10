/**
 * PR Review pipeline — two-stage invariant-aware review for a GitHub PR.
 *
 * Stage 1 ("impact filter"): given only the file paths in the diff and
 * the full list of business invariants from the cached context, ask the
 * LLM which invariants COULD be touched. Output: a subset of invariant
 * IDs. Cheap, single call, <$0.05.
 *
 * Stage 2 ("verdict"): for each touched invariant, feed it the full
 * invariant description + only the diff hunks whose file paths relate
 * to that invariant. Ask for a single verdict from a closed enum. One
 * LLM call per invariant. Sequential in Sprint 1.
 *
 * The output is a structured ReviewResult that the CLI / comment
 * poster consumes. This module never touches the GitHub API directly —
 * diff fetching lives in pr_diff.ts, comment posting in pr_comment.ts.
 */

import type { BusinessContext, CriticalFlow, CriticalInvariant } from './business_context.js';
import { loadBusinessContext, slugForRepo } from './business_context.js';
import { invokeLLMWithFallback, type Provider } from './llm_provider.js';
import type { PRDiffLoadResult, PRFile, PRHunk } from './pr_diff.js';

// ── Public types ──

export type ReviewVerdict = 'unchanged' | 'weakened' | 'broken' | 'new_gap';

export interface InvariantVerdict {
  flow_id: string;
  invariant_id: string;
  invariant_description: string;
  severity: string;
  /**
   * 2-4 sentences describing what the changed code did before vs now,
   * in plain English. Forced into the prompt as a chain-of-thought
   * scaffold so the LLM cannot snap-judge from variable names alone.
   * May be empty on legacy / failed parses.
   */
  semantic_delta: string;
  /**
   * 1-2 sentences describing the runtime / data / state implication
   * of the semantic_delta. Same scaffolding rationale.
   */
  runtime_implication: string;
  verdict: ReviewVerdict;
  evidence_hunks: string[];
  reason: string;
}

export interface ReviewResult {
  pr: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    author: string;
    head_sha: string;
  };
  context: {
    source: BusinessContext['source'];
    total_invariants: number;
  };
  touched_invariant_ids: string[];
  verdicts: InvariantVerdict[];
  diagnostics: {
    stage_a_cost_usd: number;
    stage_a_duration_ms: number;
    stage_b_cost_usd: number;
    stage_b_duration_ms: number;
    stage_b_calls: number;
    stage_b_failures: number;
  };
  too_large: boolean;
  skipped_reason?: string;
}

export interface RunPRReviewOptions {
  provider?: Provider;
  allowFallback?: boolean;
}

// ── Top-level entrypoint ──

export async function runPRReview(
  diff: PRDiffLoadResult,
  ctx: BusinessContext,
  opts?: RunPRReviewOptions
): Promise<ReviewResult> {
  const base: ReviewResult = {
    pr: {
      owner: diff.meta.owner,
      repo: diff.meta.repo,
      number: diff.meta.number,
      title: diff.meta.title,
      author: diff.meta.author,
      head_sha: diff.meta.head_sha,
    },
    context: {
      source: ctx.source,
      total_invariants: countInvariants(ctx),
    },
    touched_invariant_ids: [],
    verdicts: [],
    diagnostics: {
      stage_a_cost_usd: 0,
      stage_a_duration_ms: 0,
      stage_b_cost_usd: 0,
      stage_b_duration_ms: 0,
      stage_b_calls: 0,
      stage_b_failures: 0,
    },
    too_large: diff.too_large,
  };

  if (diff.too_large) {
    base.skipped_reason =
      `PR exceeds size guard (files=${diff.size_guard.actual_files}/${diff.size_guard.max_files}, ` +
      `changed_lines=${diff.size_guard.actual_changed_lines}/${diff.size_guard.max_changed_lines})`;
    return base;
  }

  const allInvariants = flattenInvariants(ctx);
  if (allInvariants.length === 0) {
    base.skipped_reason =
      'No cached business context found. Run `edward discover <repo>` first ' +
      'so Edward can extract this repo\'s business invariants.';
    return base;
  }

  // ── Stage 1 ──
  const stageAPrompt = buildStage1Prompt(diff, allInvariants);
  const stageACfg = {
    provider: opts?.provider ?? 'claude',
    model: (opts?.provider === 'claude' || !opts?.provider) ? 'sonnet' : undefined,
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    timeoutMs: 180_000,
    noTools: true,
  } as const;
  const stageA = await invokeLLMWithFallback(stageAPrompt, process.cwd(), stageACfg, {
    allowFallback: opts?.allowFallback !== false,
  });
  base.diagnostics.stage_a_cost_usd = stageA.costUsd;
  base.diagnostics.stage_a_duration_ms = stageA.durationMs;
  if (!stageA.ok) {
    base.skipped_reason = `Stage 1 LLM call failed: ${(stageA.error || '').slice(0, 200)}`;
    return base;
  }

  const touchedIds = parseStage1Response(stageA.stdout, allInvariants);
  base.touched_invariant_ids = touchedIds;
  if (touchedIds.length === 0) {
    return base;
  }

  // ── Stage 2 ──
  const stageBCfg = {
    provider: opts?.provider ?? 'claude',
    model: (opts?.provider === 'claude' || !opts?.provider) ? 'sonnet' : undefined,
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    timeoutMs: 180_000,
    noTools: true,
  } as const;

  const byId = new Map<string, { flow: CriticalFlow; invariant: CriticalInvariant }>();
  for (const e of allInvariants) byId.set(`${e.flow.id}::${e.invariant.id}`, e);

  for (const fqid of touchedIds) {
    const entry = byId.get(fqid);
    if (!entry) continue;
    const relevantHunks = selectRelevantHunks(diff.files, entry.flow);
    const prompt = buildStage2Prompt(diff.meta.title, diff.meta.body, entry.flow, entry.invariant, relevantHunks);

    const MAX_ATTEMPTS = 3;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      base.diagnostics.stage_b_calls++;
      const r = await invokeLLMWithFallback(prompt, process.cwd(), stageBCfg, {
        allowFallback: opts?.allowFallback !== false,
      });
      base.diagnostics.stage_b_cost_usd += r.costUsd;
      base.diagnostics.stage_b_duration_ms += r.durationMs;
      if (!r.ok) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
          continue;
        }
        base.diagnostics.stage_b_failures++;
        console.error(
          `[edward] pr-review Stage 2 failed for ${fqid} after ${MAX_ATTEMPTS} attempts: ` +
          `${(r.error || '').slice(0, 200)}`
        );
        break;
      }
      const verdict = parseStage2Response(
        r.stdout,
        entry.flow.id,
        entry.invariant.id,
        entry.invariant.description,
        entry.invariant.severity
      );
      if (verdict) {
        base.verdicts.push(verdict);
        ok = true;
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      } else {
        base.diagnostics.stage_b_failures++;
      }
    }
    if (!ok) continue;
  }

  return base;
}

// ── Context loader shim ──

/**
 * Load cached business context for a `owner/repo` slug. Only consults
 * the user cache (`~/.edward/contexts/<slug>.yml`) — PR review mode
 * intentionally does NOT auto-extract because we don't have the repo
 * checked out. Returns null if no cached context exists.
 */
export async function loadCachedContextForPRReview(
  owner: string,
  repo: string
): Promise<BusinessContext | null> {
  const slug = slugForRepo(`${owner}/${repo}`);
  // Pass a dummy repoDir; allowAutoExtract=false so the file-based /
  // auto-extract steps are bypassed. The user_cache step only needs
  // the slug.
  const ctx = await loadBusinessContext('/tmp/__edward_pr_review_dummy__', {
    repoSlug: slug,
    allowAutoExtract: false,
  });
  if (ctx.source === 'empty') return null;
  return ctx;
}

// ── Helpers ──

function countInvariants(ctx: BusinessContext): number {
  let n = 0;
  for (const flow of ctx.critical_flows) n += flow.invariants.length;
  return n;
}

function flattenInvariants(
  ctx: BusinessContext
): Array<{ flow: CriticalFlow; invariant: CriticalInvariant }> {
  const out: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }> = [];
  for (const flow of ctx.critical_flows) {
    for (const invariant of flow.invariants) {
      out.push({ flow, invariant });
    }
  }
  return out;
}

/**
 * Pick the subset of PR hunks whose file paths are likely related to a
 * given flow, using the flow's `entry_points` as fuzzy substrings. If
 * no entry_points match anything (or the flow has none), fall back to
 * returning all hunks so Stage 2 still has something to look at.
 */
function selectRelevantHunks(
  files: PRFile[],
  flow: CriticalFlow
): Array<{ file: PRFile; hunks: PRHunk[] }> {
  const points = (flow.entry_points || []).map((p) => p.toLowerCase()).filter(Boolean);
  const matched: Array<{ file: PRFile; hunks: PRHunk[] }> = [];
  for (const file of files) {
    if (file.hunks.length === 0) continue;
    const pathLower = file.path.toLowerCase();
    const isMatch =
      points.length === 0
        ? true
        : points.some((p) => pathLower.includes(p) || p.includes(pathLower));
    if (isMatch) matched.push({ file, hunks: file.hunks });
  }
  if (matched.length === 0) {
    // Fallback: give Stage 2 everything rather than nothing.
    for (const file of files) {
      if (file.hunks.length > 0) matched.push({ file, hunks: file.hunks });
    }
  }
  return matched;
}

// ── Prompts ──

function buildStage1Prompt(
  diff: PRDiffLoadResult,
  allInvariants: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }>
): string {
  const fileList = diff.files.map((f) => ({
    path: f.path,
    change: f.change,
    hunks: f.hunks.length,
    ...(f.old_path ? { old_path: f.old_path } : {}),
  }));
  const invariantList = allInvariants.map(({ flow, invariant }) => ({
    id: `${flow.id}::${invariant.id}`,
    flow_name: flow.name,
    entry_points: flow.entry_points,
    description: invariant.description,
    severity: invariant.severity,
  }));

  return `You are Edward's PR Impact Filter.

Your job is to decide which business invariants a pull request could
possibly affect. You are NOT judging whether they are broken — that is
Stage 2's job. You are only narrowing a list of ~20-50 invariants down
to the subset that is plausibly in scope.

═══════════════════════════════════════
PR METADATA
═══════════════════════════════════════
title: ${JSON.stringify(diff.meta.title)}
body: ${JSON.stringify((diff.meta.body || '').slice(0, 1000))}
base: ${diff.meta.base_ref}
head: ${diff.meta.head_ref}

═══════════════════════════════════════
CHANGED FILES (path + change type only — no patch content)
═══════════════════════════════════════
${JSON.stringify(fileList, null, 2)}

═══════════════════════════════════════
BUSINESS INVARIANTS
═══════════════════════════════════════
${JSON.stringify(invariantList, null, 2)}

═══════════════════════════════════════
YOUR JOB
═══════════════════════════════════════
Return a JSON object with this exact shape:

{
  "touched": ["flow_id::invariant_id", ...]
}

Rules:
1. Include an invariant ID if ANY changed file plausibly touches the
   code paths listed in its flow's entry_points, or if the PR
   title/body mentions a concept that matches the invariant's domain.
2. Do NOT include invariants whose flows are clearly unrelated (e.g. a
   doc-only or CI-config-only PR should return an empty touched list
   unless the invariants themselves are about docs/CI).
3. Use the EXACT IDs from the BUSINESS INVARIANTS list above. Do not
   invent new IDs.
4. When in doubt, err toward INclusion — false positives here are
   cheaper than false negatives because Stage 2 will filter out
   unchanged verdicts anyway.
5. Output ONLY the JSON object. No markdown fence. No prose.

Produce the JSON now.`;
}

function buildStage2Prompt(
  prTitle: string,
  prBody: string,
  flow: CriticalFlow,
  invariant: CriticalInvariant,
  relevantHunks: Array<{ file: PRFile; hunks: PRHunk[] }>
): string {
  const hunkBlocks = relevantHunks
    .slice(0, 20)
    .map(({ file, hunks }) => {
      const header = `=== ${file.path} (${file.change}) ===`;
      const body = hunks
        .slice(0, 10)
        .map(
          (h) =>
            `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@\n${h.patch}`
        )
        .join('\n');
      return `${header}\n${body}`;
    })
    .join('\n\n');

  return `You are Edward's Business Invariant Verdict engine.

You look at ONE business invariant and a pull request's diff and
decide whether this diff leaves the invariant intact, weakens it,
breaks it, or opens a new gap.

You MUST think before you judge. Snap judgments based only on
variable names or surface syntax produce false positives. Walk through
the semantic delta first, then judge.

═══════════════════════════════════════
INVARIANT UNDER REVIEW
═══════════════════════════════════════
flow: ${flow.id} — ${flow.name}
flow_entry_points: ${JSON.stringify(flow.entry_points)}
invariant_id: ${invariant.id}
description: ${JSON.stringify(invariant.description)}
severity: ${invariant.severity}

═══════════════════════════════════════
PR CONTEXT
═══════════════════════════════════════
title: ${JSON.stringify(prTitle)}
body: ${JSON.stringify((prBody || '').slice(0, 800))}

═══════════════════════════════════════
RELEVANT DIFF HUNKS
═══════════════════════════════════════
${hunkBlocks || '(no hunks — the PR touches no files matching this flow\'s entry_points)'}

═══════════════════════════════════════
YOUR JOB
═══════════════════════════════════════
Return a JSON object with this exact shape:

{
  "semantic_delta": "<2-4 sentences>",
  "runtime_implication": "<1-2 sentences>",
  "verdict": "unchanged" | "weakened" | "broken" | "new_gap",
  "evidence_hunks": ["file_path:line_start-line_end", ...],
  "reason": "one short sentence"
}

How to fill each field:

1. **semantic_delta** — Walk through the changed hunks and describe in
   plain English what the code DID before vs what it DOES now. Focus
   on observable behavior, not on how the code looks. Be specific
   about: which inputs are affected, what side effects change, what
   data structures/keys are touched. If the change is purely a rename
   or reorganization with no behavior change, say so explicitly. If a
   referenced symbol's actual value is not visible in the diff (e.g.
   a constant or helper imported from elsewhere), say "the value of X
   is not visible in this diff" — DO NOT guess from the variable name.

2. **runtime_implication** — Now that you have the semantic delta,
   describe the runtime / data / state implication. If the change is
   in a hot loop, say so. If it touches a shared resource (cache,
   global, database key), say what the sharing pattern is and who
   else is affected. If it changes the lifetime of a value, say what
   the new lifetime is.

3. **verdict** — ONLY THEN judge. The verdict must be exactly one of:
   - "unchanged": the semantic_delta and runtime_implication do not
     touch what the invariant guards. Default to this when in doubt.
   - "weakened": the defense still exists but is less strict. Only
     pick this if the runtime_implication clearly shows a relaxation
     (a check moved from required to optional, a timeout extended
     past a documented ceiling, an error downgraded to a warning).
   - "broken": the runtime_implication clearly bypasses or removes
     the check that was enforcing the invariant.
   - "new_gap": the diff adds a NEW code path that should enforce the
     invariant but does not.

4. **evidence_hunks** — cite the ACTUAL lines that justify your
   verdict. Format: "relative/file/path.py:120-145". If verdict is
   "unchanged", may be an empty array.

5. **reason** — one sentence summarizing the verdict. No line numbers
   here (those go in evidence_hunks).

Critical rules:

- **Variable names can lie.** A variable named \`client_timeout_10\`
  may actually hold a 300-second timeout. A function named
  \`is_safe()\` may actually do nothing. NEVER infer behavior from a
  name alone. If you cannot see the actual implementation, write
  "implementation not visible in diff" in semantic_delta and default
  to "unchanged" unless other evidence in the diff itself shows a
  behavior change.

- **The PR title and body matter.** A refactor PR titled "consolidate
  X" usually means the author intends NO behavior change. Take this
  as a strong prior — only override it if the diff itself shows
  evidence of a real behavior change.

- **Shared resources require shared-resource thinking.** If you see a
  cache key, Redis hash, global variable, or class-level state, ask:
  "who else writes to this? who else reads from this? does this
  change affect them?" Single-user reasoning on shared state is the
  most common source of missed bugs.

- Output ONLY the JSON object. No markdown fence. No prose outside.

Produce the JSON now.`;
}

// ── Response parsers ──

function parseStage1Response(
  text: string,
  allInvariants: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }>
): string[] {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return [];
  const rawTouched = Array.isArray(parsed.touched) ? parsed.touched : [];
  const validIds = new Set<string>();
  for (const e of allInvariants) validIds.add(`${e.flow.id}::${e.invariant.id}`);
  const out: string[] = [];
  for (const t of rawTouched) {
    if (typeof t !== 'string') continue;
    if (validIds.has(t)) out.push(t);
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

function parseStage2Response(
  text: string,
  flowId: string,
  invariantId: string,
  invariantDescription: string,
  severity: string
): InvariantVerdict | null {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const rawVerdict = typeof parsed.verdict === 'string' ? parsed.verdict : '';
  const ALLOWED: ReviewVerdict[] = ['unchanged', 'weakened', 'broken', 'new_gap'];
  if (!ALLOWED.includes(rawVerdict as ReviewVerdict)) return null;
  const rawEvidence = Array.isArray(parsed.evidence_hunks) ? parsed.evidence_hunks : [];
  const evidence_hunks = rawEvidence
    .filter((e: any) => typeof e === 'string')
    .map((e: string) => e.slice(0, 200))
    .slice(0, 10);
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '';
  const semantic_delta = typeof parsed.semantic_delta === 'string'
    ? parsed.semantic_delta.slice(0, 1500)
    : '';
  const runtime_implication = typeof parsed.runtime_implication === 'string'
    ? parsed.runtime_implication.slice(0, 800)
    : '';
  return {
    flow_id: flowId,
    invariant_id: invariantId,
    invariant_description: invariantDescription,
    severity,
    semantic_delta,
    runtime_implication,
    verdict: rawVerdict as ReviewVerdict,
    evidence_hunks,
    reason,
  };
}

function extractFirstJsonObject(text: string): any | null {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = trimmed.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* fall through */ }
  }
  return null;
}
