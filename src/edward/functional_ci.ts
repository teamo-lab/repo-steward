/**
 * Functional CI Gap Analysis — orchestrates the two LLM calls that turn
 *
 *     BusinessContext + FeatureSurface + TestCoverageMap + StyleSamples
 *
 * into a list of `missing_functional_test` findings. Each finding is a
 * concrete test scaffold the user can copy into their repo.
 *
 * This is the flagship phase of the Functional-CI sprint. Everything
 * upstream (static source enumeration, YAML context, framework
 * detection) exists to feed these two calls:
 *
 *   PHASE A — Invariant Coverage Judgment
 *   ──────────────────────────────────────
 *   "Given the list of business invariants from .edward/context.yml,
 *    and the set of existing tests in the project, which invariants
 *    have at least one test that plausibly checks them?"
 *
 *   Output: list of { invariant_id, covered: bool, covering_test?, reasoning }
 *
 *   PHASE B — Test Synthesis (batched)
 *   ──────────────────────────
 *   "For each uncovered invariant, write a complete, runnable test
 *    function in the style of these sample tests from the project."
 *
 *   Output: list of { invariant_id, test_code, test_filename, boundary_cases }
 *
 * The two phases are separate calls because (a) coverage judgment is a
 * pure reasoning task and benefits from low temperature / small prompt,
 * and (b) test synthesis needs more "creativity budget" plus the style
 * samples blown up in context. Keeping them apart also means a coverage
 * call that fails doesn't waste budget on synthesis.
 *
 * IMPORTANT: everything in this file is language-agnostic. The LLM is
 * the one that writes Python or TypeScript or Go based on the style
 * samples we feed it. No per-language branching here.
 */

import { invokeLLMWithFallback, type Provider } from './llm_provider.js';
import type { BusinessContext, CriticalFlow, CriticalInvariant } from './business_context.js';
import { contextForPrompt, contextIsActionable } from './business_context.js';
import type { FeatureSurface } from './feature_inventory.js';
import { surfaceForPrompt } from './feature_inventory.js';
import type { TestCoverageMap, TestFile } from './test_mapping.js';
import { coverageForPrompt, sampleTestStyleReference } from './test_mapping.js';

// ── Public types ──

export interface InvariantCoverageJudgment {
  flow_id: string;
  invariant_id: string;
  covered: boolean;
  covering_test?: string;    // test file path or test function name
  reasoning: string;
}

export interface SynthesizedTest {
  flow_id: string;
  invariant_id: string;
  invariant_description: string;
  invariant_severity: 'low' | 'medium' | 'high';
  suggested_filename: string;
  test_code: string;
  /** Additional edge cases the LLM suggests covering. */
  boundary_cases: string[];
}

export interface FunctionalCIResult {
  /** Business context that drove the analysis. */
  context_source: BusinessContext['source'];
  /** Raw invariant coverage judgments. */
  judgments: InvariantCoverageJudgment[];
  /** One per uncovered invariant, with generated test code. */
  synthesized: SynthesizedTest[];
  /** Phase-level diagnostics for logs + debug dumps. */
  diagnostics: {
    invariants_total: number;
    invariants_covered: number;
    invariants_uncovered: number;
    phase_a_cost_usd: number;
    phase_a_duration_ms: number;
    phase_b_cost_usd: number;
    phase_b_duration_ms: number;
    synth_batches: number;
  };
  /** Set when a phase fails; functional CI findings should be skipped. */
  error?: string;
}

// ── Main entry ──

/**
 * Run the two-phase functional CI analysis. Pure function:
 * side-effect free aside from LLM subprocess calls.
 *
 * Never throws — returns `result.error` on total failure.
 */
export async function runFunctionalCIAnalysis(
  repoDir: string,
  ctx: BusinessContext,
  surface: FeatureSurface,
  coverage: TestCoverageMap,
  opts: {
    provider?: Provider;
    allowFallback?: boolean;
    /** Dominant language of the project, used to bias style samples. */
    preferredExt?: string;
  }
): Promise<FunctionalCIResult> {
  const result: FunctionalCIResult = {
    context_source: ctx.source,
    judgments: [],
    synthesized: [],
    diagnostics: {
      invariants_total: 0,
      invariants_covered: 0,
      invariants_uncovered: 0,
      phase_a_cost_usd: 0,
      phase_a_duration_ms: 0,
      phase_b_cost_usd: 0,
      phase_b_duration_ms: 0,
      synth_batches: 0,
    },
  };

  // Short-circuit: no actionable invariants → no work.
  if (!contextIsActionable(ctx)) {
    result.error = 'no_actionable_invariants';
    return result;
  }

  const allInvariants: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }> = [];
  for (const flow of ctx.critical_flows) {
    for (const inv of flow.invariants) {
      allInvariants.push({ flow, invariant: inv });
    }
  }
  result.diagnostics.invariants_total = allInvariants.length;

  // ── PHASE A: coverage judgment ──

  const phaseACallConfig = {
    provider: opts.provider ?? 'claude',
    model: (opts.provider === 'claude' || !opts.provider) ? 'sonnet' : undefined,
    maxTurns: 3,
    maxBudgetUsd: 0.75,
    timeoutMs: 240_000,
    // Pure reasoning over inlined JSON inputs — claude does not need
    // to explore the cwd. Without noTools=true, claude hangs trying
    // to Read/Grep the target repo instead of emitting the judgment
    // object. See llm_provider.ts spawnClaude for the full rationale.
    noTools: true,
  } as const;

  const phaseAPrompt = buildCoveragePrompt(ctx, surface, coverage);
  const phaseAResult = await invokeLLMWithFallback(
    phaseAPrompt,
    repoDir,
    phaseACallConfig,
    { allowFallback: opts.allowFallback !== false }
  );
  result.diagnostics.phase_a_cost_usd = phaseAResult.costUsd;
  result.diagnostics.phase_a_duration_ms = phaseAResult.durationMs;

  if (!phaseAResult.ok) {
    result.error = `phase_a_failed: ${phaseAResult.error?.slice(0, 200) || 'unknown'}`;
    return result;
  }

  const judgments = parseCoverageJudgments(phaseAResult.stdout, allInvariants);
  result.judgments = judgments;
  result.diagnostics.invariants_covered = judgments.filter((j) => j.covered).length;
  result.diagnostics.invariants_uncovered = judgments.filter((j) => !j.covered).length;

  const uncovered = judgments.filter((j) => !j.covered);
  if (uncovered.length === 0) {
    // Nothing to synthesize — early return with full judgments.
    return result;
  }

  // ── PHASE B: test synthesis ──

  const styleSamples = sampleTestStyleReference(repoDir, coverage.test_files, {
    n: 3,
    preferredExt: opts.preferredExt,
    maxBytesPerFile: 6_000,
  });

  const phaseBCallConfig = {
    provider: opts.provider ?? 'claude',
    model: (opts.provider === 'claude' || !opts.provider) ? 'sonnet' : undefined,
    maxTurns: 3,
    maxBudgetUsd: 1.5,
    timeoutMs: 240_000,
    // Pure code-generation task — style samples and target invariants
    // are inlined in the prompt, so there is no value in letting
    // claude read the cwd. noTools=true prevents the agent-mode
    // hang/timeout we observed previously.
    noTools: true,
  } as const;

  // Batch uncovered invariants into groups of 5 to keep prompts focused
  // while limiting the number of LLM calls.
  const BATCH_SIZE = 5;
  const batches: InvariantCoverageJudgment[][] = [];
  for (let i = 0; i < uncovered.length; i += BATCH_SIZE) {
    batches.push(uncovered.slice(i, i + BATCH_SIZE));
  }
  result.diagnostics.synth_batches = batches.length;

  for (const batch of batches) {
    const prompt = buildSynthPrompt(ctx, batch, styleSamples, allInvariants, opts.preferredExt);
    const r = await invokeLLMWithFallback(
      prompt,
      repoDir,
      phaseBCallConfig,
      { allowFallback: opts.allowFallback !== false }
    );
    result.diagnostics.phase_b_cost_usd += r.costUsd;
    result.diagnostics.phase_b_duration_ms += r.durationMs;
    if (!r.ok) {
      // One failing batch is not fatal — record what we have so far
      // and keep going. The caller can see partial results.
      console.error(
        `[edward] functional-ci synth batch failed: ${r.error?.slice(0, 200) || 'unknown'}`
      );
      continue;
    }
    const parsed = parseSynthResponse(r.stdout, batch, allInvariants);
    result.synthesized.push(...parsed);
  }

  return result;
}

// ── Phase A prompt construction ──

function buildCoveragePrompt(
  ctx: BusinessContext,
  surface: FeatureSurface,
  coverage: TestCoverageMap
): string {
  const ctxBlock = JSON.stringify(contextForPrompt(ctx), null, 2);
  const surfaceBlock = JSON.stringify(surfaceForPrompt(surface, { maxPerKind: 25 }), null, 2);
  const coverageBlock = JSON.stringify(
    coverageForPrompt(coverage, { maxPerKind: 25, includeCovered: false }),
    null,
    2
  );

  return `You are Repo Steward's Functional CI Gap Analyzer.

Your task: for each business INVARIANT in BUSINESS_CONTEXT.critical_flows,
decide whether the project's existing test suite plausibly covers it.

"Plausibly covers" means: a test exists that would FAIL if the invariant
were broken in a normal way. Not "a test exists in the same area" or
"a test mentions a related word" — it must be a test whose assertions
would trip when this specific rule is violated.

═══════════════════════════════════════
INPUT 1 — BUSINESS_CONTEXT (ground truth for what the project is)
═══════════════════════════════════════
${ctxBlock}

═══════════════════════════════════════
INPUT 2 — FEATURE_SURFACE (code-level enumeration of what the project exposes)
═══════════════════════════════════════
${surfaceBlock}

═══════════════════════════════════════
INPUT 3 — TEST_COVERAGE_MAP (which existing tests reference which features)
═══════════════════════════════════════
${coverageBlock}

═══════════════════════════════════════
YOUR JOB
═══════════════════════════════════════

For EVERY invariant listed in BUSINESS_CONTEXT.critical_flows, emit one
judgment entry. The output shape is:

{
  "judgments": [
    {
      "flow_id": "<flow.id>",
      "invariant_id": "<invariant.id>",
      "covered": true | false,
      "covering_test": "<test file path or test fn name>" or null,
      "reasoning": "<one sentence explaining the decision>"
    },
    ...
  ]
}

Rules:

1. Be STRICT. If you're not sure a test directly checks the invariant,
   mark it uncovered. False negatives are cheaper than false positives
   here — we'd rather generate one more test than let a gap slip.

2. For each UNcovered judgment, leave covering_test null.

3. For each COVERED judgment, covering_test must point at a concrete
   test — either a file path or a specific test function name from
   TEST_COVERAGE_MAP.test_files[].tests_sampled or by_kind[].covering.

4. Do NOT invent test functions that don't appear in the input.

5. If a flow has zero entry_points matching any FEATURE_SURFACE or
   TEST_COVERAGE_MAP entry, you may still judge its invariants — use
   reasoning="no code-level evidence for this flow" and covered=false.

6. Output MUST be ONE JSON object starting with { and ending with }.
   No prose, no markdown fence, no explanation outside the object.

Produce the JSON now.`;
}

// ── Phase A response parsing ──

function parseCoverageJudgments(
  text: string,
  allInvariants: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }>
): InvariantCoverageJudgment[] {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return [];
  const rawList = Array.isArray(parsed.judgments) ? parsed.judgments : [];

  // Build lookup so the model can't invent flow_id / invariant_id combos
  const validKeys = new Set(
    allInvariants.map((x) => `${x.flow.id}::${x.invariant.id}`)
  );

  const out: InvariantCoverageJudgment[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const flow_id = String(raw.flow_id || '').trim();
    const invariant_id = String(raw.invariant_id || '').trim();
    if (!flow_id || !invariant_id) continue;
    if (!validKeys.has(`${flow_id}::${invariant_id}`)) continue;
    out.push({
      flow_id,
      invariant_id,
      covered: Boolean(raw.covered),
      covering_test: raw.covering_test ? String(raw.covering_test) : undefined,
      reasoning: String(raw.reasoning || ''),
    });
  }

  // Backfill any invariants the model skipped as "uncovered, no reasoning"
  // — we want a judgment for every invariant, or downstream synthesis
  // can't tell what to generate.
  const seen = new Set(out.map((j) => `${j.flow_id}::${j.invariant_id}`));
  for (const x of allInvariants) {
    const key = `${x.flow.id}::${x.invariant.id}`;
    if (seen.has(key)) continue;
    out.push({
      flow_id: x.flow.id,
      invariant_id: x.invariant.id,
      covered: false,
      reasoning: 'model did not emit a judgment for this invariant',
    });
  }

  return out;
}

// ── Phase B prompt construction ──

function buildSynthPrompt(
  ctx: BusinessContext,
  batch: InvariantCoverageJudgment[],
  styleSamples: Array<{ path: string; content: string }>,
  allInvariants: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }>,
  preferredExt?: string
): string {
  const invariantLookup = new Map<string, { flow: CriticalFlow; invariant: CriticalInvariant }>();
  for (const x of allInvariants) {
    invariantLookup.set(`${x.flow.id}::${x.invariant.id}`, x);
  }

  const batchDetails = batch.map((j) => {
    const found = invariantLookup.get(`${j.flow_id}::${j.invariant_id}`);
    if (!found) return null;
    return {
      flow_id: found.flow.id,
      flow_name: found.flow.name,
      entry_points: found.flow.entry_points,
      invariant_id: found.invariant.id,
      invariant_description: found.invariant.description,
      severity: found.invariant.severity,
    };
  }).filter((x) => x !== null);

  const styleBlock = styleSamples.length > 0
    ? styleSamples.map((s) => `--- ${s.path} ---\n${s.content}`).join('\n\n')
    : '(no existing test files found — use idiomatic style for the language)';

  const langHint = preferredExt
    ? `The project's dominant test language appears to be ".${preferredExt}". Generate tests in that language unless the entry_points for an invariant clearly belong to a different language.`
    : 'Match the language of each invariant\'s entry_points.';

  return `You are Repo Steward's Functional CI Test Synthesizer.

For each UNCOVERED business invariant listed in TARGETS, write a
complete, runnable test function that would FAIL if the invariant were
violated. The tests will be copy-pasted by the user into their project,
so they must be syntactically valid and stylistically consistent with
the project's existing tests.

═══════════════════════════════════════
INPUT 1 — PROJECT SUMMARY
═══════════════════════════════════════

${JSON.stringify(ctx.project, null, 2)}

═══════════════════════════════════════
INPUT 2 — STYLE REFERENCE (existing tests from the project)
═══════════════════════════════════════

${langHint}

Read these carefully. Match their:
- Language, imports, fixtures, mocks, async patterns
- Test naming conventions (test_snake_case vs camelCase vs it("..."))
- Assertion library (pytest/assertpy/chai/jest/testify/...)
- Setup/teardown patterns
- Docstring / comment style

${styleBlock}

═══════════════════════════════════════
INPUT 3 — TARGETS (uncovered invariants that need tests)
═══════════════════════════════════════

${JSON.stringify(batchDetails, null, 2)}

═══════════════════════════════════════
YOUR JOB
═══════════════════════════════════════

For each TARGET, produce a JSON entry with this shape:

{
  "flow_id": "<from target>",
  "invariant_id": "<from target>",
  "suggested_filename": "<repo-relative path, e.g. tests/test_<slug>.py>",
  "test_code": "<complete test code including imports/fixtures/asserts>",
  "boundary_cases": ["<additional edge case 1>", "<additional edge case 2>", ...]
}

Rules:

1. test_code MUST be complete and runnable — all imports present,
   fixtures declared, assertions explicit. No "... (fill in) ...".

2. Match the style samples above. If the project uses pytest, use
   pytest. If it uses unittest, use unittest. If it uses jest, use
   jest. Do NOT introduce a new test framework.

3. One test function per invariant (no parametrized fits-all tests
   unless the style samples show that's the convention).

4. The test must make the invariant's rule OBSERVABLE — if the test
   would pass whether or not the rule holds, it's useless. Your
   assertion must target the specific claim in invariant.description.

5. If an invariant is abstract ("data integrity must be preserved"),
   pick a concrete scenario that would break if it weren't and test
   THAT.

6. boundary_cases is 2-4 short strings describing edge cases the user
   should also cover — don't write code for these, just list them.

7. suggested_filename should be a path that doesn't collide with
   existing tests. Prefer .../test_<flow_id>_<invariant_id>.<ext>
   format.

8. Output MUST be ONE JSON object like this:

{
  "tests": [ { /* one per target */ } ]
}

Nothing outside the object. No markdown code fence. No prose.

Produce the JSON now.`;
}

// ── Phase B response parsing ──

function parseSynthResponse(
  text: string,
  batch: InvariantCoverageJudgment[],
  allInvariants: Array<{ flow: CriticalFlow; invariant: CriticalInvariant }>
): SynthesizedTest[] {
  const parsed = extractFirstJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return [];
  const rawList = Array.isArray(parsed.tests) ? parsed.tests : [];

  const invariantLookup = new Map<string, { flow: CriticalFlow; invariant: CriticalInvariant }>();
  for (const x of allInvariants) {
    invariantLookup.set(`${x.flow.id}::${x.invariant.id}`, x);
  }

  const batchKeys = new Set(batch.map((j) => `${j.flow_id}::${j.invariant_id}`));

  const out: SynthesizedTest[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const flow_id = String(raw.flow_id || '').trim();
    const invariant_id = String(raw.invariant_id || '').trim();
    if (!flow_id || !invariant_id) continue;
    const key = `${flow_id}::${invariant_id}`;
    if (!batchKeys.has(key)) continue;
    const lookup = invariantLookup.get(key);
    if (!lookup) continue;
    const test_code = typeof raw.test_code === 'string' ? raw.test_code : '';
    if (!test_code.trim()) continue;
    const boundary = Array.isArray(raw.boundary_cases)
      ? raw.boundary_cases.map(String).slice(0, 6)
      : [];
    out.push({
      flow_id,
      invariant_id,
      invariant_description: lookup.invariant.description,
      invariant_severity: lookup.invariant.severity,
      suggested_filename: String(raw.suggested_filename || `tests/test_${flow_id}_${invariant_id}.py`),
      test_code,
      boundary_cases: boundary,
    });
  }

  return out;
}

// ── Shared JSON extraction helper ──

/**
 * Pull the first top-level JSON object from a raw LLM response. Tries:
 *   1. Direct JSON.parse of the trimmed text
 *   2. Slice from first `{` to last `}`
 * Returns null on total failure.
 */
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

// ── Task conversion ──

/**
 * Convert a SynthesizedTest into an EdwardTask-compatible shape for
 * insertion into the suggestions queue. Generates a new uuid and
 * leaves repo_id blank — caller fills that in.
 *
 * The description is formatted as markdown with a ```code fence so the
 * dashboard can render it readably, and the test_code is the dominant
 * content so reviewers see "here's what Edward wrote" front and center.
 */
export function synthesizedTestToTaskFields(s: SynthesizedTest): {
  type: string;
  title: string;
  description: string;
  risk_level: string;
  confidence: number;
  evidence: Record<string, unknown>;
  impact: Record<string, unknown>;
  verification: Record<string, unknown>;
} {
  const riskMap: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' };
  const risk = riskMap[s.invariant_severity] || 'medium';
  const confidence = s.invariant_severity === 'high' ? 0.95 : s.invariant_severity === 'medium' ? 0.9 : 0.85;
  const boundaryBlock = s.boundary_cases.length > 0
    ? '\n\n**Additional boundary cases to cover:**\n' + s.boundary_cases.map((b) => `- ${b}`).join('\n')
    : '';
  const description = [
    `**Flow:** ${s.flow_id}`,
    `**Invariant:** ${s.invariant_description}`,
    `**Severity:** ${s.invariant_severity}`,
    '',
    `**Suggested test file:** \`${s.suggested_filename}\``,
    '',
    '```',
    s.test_code,
    '```',
    boundaryBlock,
  ].join('\n');

  return {
    type: 'missing_functional_test',
    title: `Missing CI test: ${s.flow_id} — ${s.invariant_id}`,
    description,
    risk_level: risk,
    confidence,
    evidence: {
      source: 'functional_ci_gap_analysis',
      flow_id: s.flow_id,
      invariant_id: s.invariant_id,
      invariant_description: s.invariant_description,
      boundary_cases: s.boundary_cases,
    },
    impact: {
      estimatedFiles: [s.suggested_filename],
      estimatedLinesChanged: Math.min(100, s.test_code.split('\n').length + 5),
      blastRadius: 'isolated',
    },
    verification: {
      method: 'Add the suggested test file and run the project\'s existing test runner',
      steps: [
        `Create ${s.suggested_filename}`,
        'Paste the Edward-generated test function',
        'Resolve any project-specific import paths or fixture names',
        'Run the project\'s test suite; the new test should pass on current code',
        'Deliberately break the invariant and re-run; the new test should now fail',
      ],
      successCriteria: [
        'Test passes on current code',
        'Test fails when the invariant is deliberately violated',
        'Test is added to CI so every PR runs it',
      ],
    },
  };
}
