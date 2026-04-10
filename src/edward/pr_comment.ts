/**
 * PR comment poster — writes a single top-level markdown comment on a
 * GitHub PR with Edward's review verdicts. Uses a stable HTML-comment
 * marker so rerunning `edward review` on the same PR replaces the old
 * comment instead of stacking duplicates.
 *
 * Top-level only for Sprint 1 — inline line-level comments are left
 * for a later sprint because they require commit_id + position
 * resolution which is surprisingly fiddly.
 */

import { execSync } from 'node:child_process';
import type { ReviewResult, InvariantVerdict } from './pr_review.js';

export const EDWARD_COMMENT_MARKER = '<!-- edward:review:v1 -->';

function runGh(args: string[]): string {
  // We pass args as an array to avoid shell quoting pitfalls, but
  // execSync only takes a string. Build a quoted command defensively.
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  try {
    return execSync(`gh ${quoted}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.message || '').slice(0, 400);
    throw new Error(`gh ${args[0]} failed: ${stderr}`);
  }
}

/**
 * Post (or replace) Edward's review comment on a PR.
 * Returns the comment URL, or null on failure.
 */
export async function postReviewComment(result: ReviewResult): Promise<string | null> {
  const { owner, repo, number } = result.pr;
  const body = renderCommentBody(result);

  // 1. Find any existing edward:review:v1 comment on this PR and
  //    delete it, so we never stack duplicates.
  try {
    const listRaw = runGh([
      'api',
      `repos/${owner}/${repo}/issues/${number}/comments`,
      '--paginate',
    ]);
    const existing = JSON.parse(listRaw) as Array<{ id: number; body: string }>;
    for (const c of existing) {
      if (typeof c.body === 'string' && c.body.includes(EDWARD_COMMENT_MARKER)) {
        try {
          runGh([
            'api',
            '--method', 'DELETE',
            `repos/${owner}/${repo}/issues/comments/${c.id}`,
          ]);
        } catch (delErr: any) {
          console.error(`[edward] failed to delete stale comment ${c.id}: ${delErr?.message || delErr}`);
        }
      }
    }
  } catch (listErr: any) {
    console.error(`[edward] failed to list comments for dedup: ${listErr?.message || listErr}`);
    // Fall through — posting a possibly-duplicate comment is better
    // than failing the whole review.
  }

  // 2. Post the new comment via `gh pr comment`.
  try {
    const out = runGh([
      'pr', 'comment', String(number),
      '--repo', `${owner}/${repo}`,
      '--body', body,
    ]);
    const match = out.match(/https?:\/\/\S+/);
    return match ? match[0] : null;
  } catch (postErr: any) {
    console.error(`[edward] failed to post review comment: ${postErr?.message || postErr}`);
    return null;
  }
}

// ── Body rendering ──

export function renderCommentBody(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(EDWARD_COMMENT_MARKER);
  lines.push('## 🦆 Edward — Business Invariant Review');
  lines.push('');

  if (result.too_large) {
    lines.push(`> ⏭ Skipped: ${result.skipped_reason || 'PR too large'}`);
    lines.push('');
    lines.push(appendixMetadata(result));
    return lines.join('\n');
  }

  if (result.skipped_reason) {
    lines.push(`> ⚠ ${result.skipped_reason}`);
    lines.push('');
    lines.push(appendixMetadata(result));
    return lines.join('\n');
  }

  const touched = result.verdicts.length;
  const broken = result.verdicts.filter((v) => v.verdict === 'broken');
  const weakened = result.verdicts.filter((v) => v.verdict === 'weakened');
  const newGap = result.verdicts.filter((v) => v.verdict === 'new_gap');
  const unchanged = result.verdicts.filter((v) => v.verdict === 'unchanged');

  if (touched === 0) {
    lines.push(`✅ **No business invariants touched by this PR.**`);
    lines.push('');
    lines.push(`Edward checked all ${result.context.total_invariants} invariants against the changed file set and found none in scope.`);
    lines.push('');
    lines.push(appendixMetadata(result));
    return lines.join('\n');
  }

  const redFlags = broken.length + weakened.length + newGap.length;
  if (redFlags === 0) {
    lines.push(`✅ PR touches **${touched}** invariant(s); all verdicts are **unchanged**.`);
  } else {
    lines.push(`⚠ PR touches **${touched}** invariant(s); **${redFlags}** need attention.`);
  }
  lines.push('');

  if (broken.length > 0) {
    lines.push('### ❌ Broken');
    for (const v of broken) lines.push(renderVerdict(v));
    lines.push('');
  }
  if (weakened.length > 0) {
    lines.push('### ⚠ Weakened');
    for (const v of weakened) lines.push(renderVerdict(v));
    lines.push('');
  }
  if (newGap.length > 0) {
    lines.push('### 🕳 New gap');
    for (const v of newGap) lines.push(renderVerdict(v));
    lines.push('');
  }
  if (unchanged.length > 0) {
    lines.push('<details><summary>✓ Unchanged (' + unchanged.length + ')</summary>');
    lines.push('');
    for (const v of unchanged) {
      lines.push(`- \`${v.flow_id}::${v.invariant_id}\` — ${escapeInline(v.invariant_description)}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push(appendixMetadata(result));
  return lines.join('\n');
}

function renderVerdict(v: InvariantVerdict): string {
  const evidenceStr =
    v.evidence_hunks.length > 0
      ? v.evidence_hunks.map((e) => `\`${e}\``).join(', ')
      : '_(no specific hunks cited)_';
  const lines: string[] = [
    `- **\`${v.flow_id} / ${v.invariant_id}\`** (${v.severity})`,
    `  _${escapeInline(v.invariant_description)}_`,
  ];
  if (v.semantic_delta) {
    lines.push(`  **What changed:** ${escapeInline(v.semantic_delta)}`);
  }
  if (v.runtime_implication) {
    lines.push(`  **Runtime impact:** ${escapeInline(v.runtime_implication)}`);
  }
  lines.push(`  **Reason:** ${escapeInline(v.reason)}`);
  lines.push(`  **Evidence:** ${evidenceStr}`);
  return lines.join('\n');
}

function appendixMetadata(result: ReviewResult): string {
  const lines = [
    '<details><summary>ℹ Methodology</summary>',
    '',
    `- Context source: \`${result.context.source}\``,
    `- Invariants on file: ${result.context.total_invariants}`,
    `- Stage 1 filter cost: $${result.diagnostics.stage_a_cost_usd.toFixed(3)}`,
    `- Stage 2 verdict cost: $${result.diagnostics.stage_b_cost_usd.toFixed(3)} ` +
      `(${result.diagnostics.stage_b_calls} call(s), ${result.diagnostics.stage_b_failures} failure(s))`,
    `- Total duration: ${(result.diagnostics.stage_a_duration_ms + result.diagnostics.stage_b_duration_ms) / 1000}s`,
    '',
    `Regenerate the business context with \`edward discover ${result.pr.owner}/${result.pr.repo}\`.`,
    '',
    '</details>',
  ];
  return lines.join('\n');
}

function escapeInline(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}
