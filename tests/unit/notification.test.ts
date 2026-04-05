import { describe, it, expect } from 'vitest';
import {
  formatTaskForSlack,
  formatTaskForEmail,
  formatTaskForGitHub,
} from '../../src/services/notification.js';
import type { Task } from '../../src/types/index.js';

const mockTask: Task = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  repoId: '660e8400-e29b-41d4-a716-446655440000',
  signalIds: ['770e8400-e29b-41d4-a716-446655440000'],
  type: 'ci_fix',
  status: 'suggested',
  title: 'Fix CI: TypeScript build failure',
  description: 'TypeScript compilation failed on main branch with 2 type errors',
  evidence: {
    signals: ['CI check "build" failed on main', 'Error in src/index.ts:15'],
    logSnippets: ['error TS2322: Type string is not assignable to type number'],
  },
  impact: {
    estimatedFiles: ['src/index.ts', 'src/types.ts'],
    estimatedLinesChanged: 10,
    blastRadius: 'isolated',
  },
  verification: {
    method: 'CI passes on fix branch',
    steps: ['Push fix', 'Wait for CI', 'Verify green'],
    successCriteria: ['All CI checks pass', 'No regressions'],
  },
  confidence: 0.85,
  riskLevel: 'low',
  suggestedAt: new Date('2026-04-05T06:00:00Z'),
  approvedAt: null,
  completedAt: null,
  createdAt: new Date('2026-04-05T05:55:00Z'),
  updatedAt: new Date('2026-04-05T06:00:00Z'),
};

describe('formatTaskForSlack', () => {
  it('returns valid Slack Block Kit payload', () => {
    const payload = formatTaskForSlack(mockTask);
    expect(payload.blocks).toBeDefined();
    expect(Array.isArray(payload.blocks)).toBe(true);
  });

  it('includes task title and description', () => {
    const payload = formatTaskForSlack(mockTask);
    const blocks = payload.blocks as any[];
    const sectionText = blocks[0].text.text;
    expect(sectionText).toContain('Fix CI: TypeScript build failure');
  });

  it('includes action buttons', () => {
    const payload = formatTaskForSlack(mockTask);
    const blocks = payload.blocks as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(3);
  });

  it('includes risk level and confidence', () => {
    const payload = formatTaskForSlack(mockTask);
    const blocks = payload.blocks as any[];
    const fields = blocks[1].fields;
    const riskField = fields.find((f: any) => f.text.includes('Risk'));
    expect(riskField.text).toContain('low');
    const confField = fields.find((f: any) => f.text.includes('Confidence'));
    expect(confField.text).toContain('85%');
  });
});

describe('formatTaskForEmail', () => {
  it('returns subject and html', () => {
    const result = formatTaskForEmail(mockTask);
    expect(result.subject).toBe('[Repo Steward] Fix CI: TypeScript build failure');
    expect(result.html).toBeTruthy();
  });

  it('includes task details in HTML', () => {
    const result = formatTaskForEmail(mockTask);
    expect(result.html).toContain('ci_fix');
    expect(result.html).toContain('low');
    expect(result.html).toContain('85%');
  });

  it('includes action links', () => {
    const result = formatTaskForEmail(mockTask);
    expect(result.html).toContain('Approve');
    expect(result.html).toContain('Dismiss');
    expect(result.html).toContain('Snooze');
  });
});

describe('formatTaskForGitHub', () => {
  it('returns title and body', () => {
    const result = formatTaskForGitHub(mockTask);
    expect(result.title).toBe('[Steward] Fix CI: TypeScript build failure');
    expect(result.body).toBeTruthy();
  });

  it('includes evidence in body', () => {
    const result = formatTaskForGitHub(mockTask);
    expect(result.body).toContain('CI check "build" failed on main');
  });

  it('includes verification checklist', () => {
    const result = formatTaskForGitHub(mockTask);
    expect(result.body).toContain('- [ ] Push fix');
    expect(result.body).toContain('- [ ] Wait for CI');
  });

  it('includes confidence percentage', () => {
    const result = formatTaskForGitHub(mockTask);
    expect(result.body).toContain('85%');
  });
});
