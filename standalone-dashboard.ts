/**
 * Standalone Repo Steward Dashboard — zero external dependencies
 * Uses in-memory data store, no Postgres/Redis needed
 * Run: npx tsx standalone-dashboard.ts
 * Open: http://localhost:8080
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8080;

// ── In-memory store ──

interface Task {
  id: string;
  repo_id: string;
  signal_ids: string[];
  type: string;
  status: string;
  title: string;
  description: string;
  evidence: any;
  impact: any;
  verification: any;
  confidence: number;
  risk_level: string;
  suggested_at: string;
  approved_at: string | null;
  completed_at: string | null;
  dismiss_reason: string | null;
  snooze_until: string | null;
  execution_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Execution {
  id: string;
  task_id: string;
  repo_id: string;
  status: string;
  agent_provider: string;
  branch_name: string;
  pr_number: number | null;
  pr_url: string | null;
  logs: { timestamp: string; level: string; message: string }[];
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const repos = [
  {
    id: 'clawschool-001',
    github_id: 1178532043,
    owner: 'teamo-lab',
    name: 'clawschool',
    full_name: 'teamo-lab/clawschool',
    installation_id: 0,
    default_branch: 'main',
    language: 'Python',
    is_active: true,
    settings: {
      maxDailySuggestions: 5,
      enabledTaskTypes: ['ci_fix', 'deploy_fix', 'todo_cleanup', 'test_gap'],
      notificationChannels: ['github'],
      confidenceThreshold: 0.4,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const tasks: Task[] = [
  {
    id: uuid(), repo_id: 'clawschool-001', signal_ids: ['s1'], type: 'ci_fix', status: 'suggested',
    title: 'Fix: dashboard 统计字段取值错误 (payload.* vs payload.summary.*)',
    description: 'commit 945a36be 修复了 dashboard 分享出口统计从 summary 取数的问题，紧接着 d3b65d99 又修复了 share_clicks source 映射缺失历史旧名。两个连续 bugfix 说明数据访问层缺乏类型安全和集成验证。',
    evidence: {
      signals: ['commit 945a36be: payload.summary.* 取值修复', 'commit d3b65d99: share_clicks source 映射补全'],
      logSnippets: ['Fix: dashboard 分享出口统计从 summary 取数（payload.summary.* 而非 payload.*）'],
    },
    impact: { estimatedFiles: ['app/main.py', 'app/reporting.py'], estimatedLinesChanged: 25, blastRadius: 'module' },
    verification: { method: 'API 返回正确统计数据', steps: ['修复数据访问层类型定义', '补充 reporting 集成测试', '验证 /api/stats 返回正确'], successCriteria: ['统计数据与 DB 一致', '无 KeyError'] },
    confidence: 0.82, risk_level: 'low', suggested_at: now(), approved_at: null, completed_at: null,
    dismiss_reason: null, snooze_until: null, execution_id: null, created_at: now(), updated_at: now(),
  },
  {
    id: uuid(), repo_id: 'clawschool-001', signal_ids: ['s2'], type: 'deploy_fix', status: 'suggested',
    title: 'Fix: q7 PPT制作升级 banana-slides 服务卡死服务器',
    description: 'commit b70fedb6 临时禁用了 q7 PPT 制作升级以避免 banana-slides 服务卡死服务器，但根因未修复。需要增加超时控制、资源限制或异步化处理。',
    evidence: {
      signals: ['commit b70fedb6: 禁用 q7 PPT制作升级', '服务器 OOM / hang 风险未根治'],
      logSnippets: ['Fix: 禁用 q7 PPT制作升级，避免 banana-slides 服务卡死服务器'],
    },
    impact: { estimatedFiles: ['app/main.py', 'app/questions.py'], estimatedLinesChanged: 40, blastRadius: 'module' },
    verification: { method: '恢复 q7 功能且不卡死', steps: ['为 banana-slides 调用加超时(30s)', '加内存/CPU 限制', '压测验证不 OOM'], successCriteria: ['q7 恢复可用', '服务器稳定'], rollbackPlan: '再次禁用 q7' },
    confidence: 0.75, risk_level: 'medium', suggested_at: now(), approved_at: null, completed_at: null,
    dismiss_reason: null, snooze_until: null, execution_id: null, created_at: now(), updated_at: now(),
  },
  {
    id: uuid(), repo_id: 'clawschool-001', signal_ids: ['s3'], type: 'test_gap', status: 'suggested',
    title: '项目零测试覆盖：scorer.py 评分逻辑无单元测试',
    description: '348 个文件，0 个测试文件。核心评分逻辑 scorer.py 包含 12 道题的独立评分函数(SCORERS dict)，任何评分变更都可能影响排行榜数据一致性，但没有任何自动化测试保护。',
    evidence: {
      signals: ['代码扫描：0 test files / 348 total files', 'scorer.py 包含 12 个评分函数，排行榜直接依赖'],
    },
    impact: { estimatedFiles: ['app/scorer.py', 'tests/test_scorer.py (new)'], estimatedLinesChanged: 120, blastRadius: 'isolated' },
    verification: { method: '添加测试并 CI 通过', steps: ['为每个评分函数写 pytest 用例', '覆盖边界值和异常输入', '配置 pytest CI'], successCriteria: ['scorer.py 覆盖率 > 80%', '所有用例通过'] },
    confidence: 0.68, risk_level: 'low', suggested_at: now(), approved_at: null, completed_at: null,
    dismiss_reason: null, snooze_until: null, execution_id: null, created_at: now(), updated_at: now(),
  },
  {
    id: uuid(), repo_id: 'clawschool-001', signal_ids: ['s4'], type: 'todo_cleanup', status: 'suggested',
    title: 'SKILL.md PGT v1 升级：scorer.py 格式不兼容',
    description: 'TODO.md 记录：新版 SKILL.md (PGT改版) 的 summary.json 格式不兼容现有 scorer.py，缺少 token/lobster_name 字段，字段结构完全不同。如采用需同步重写 scorer.py。',
    evidence: {
      signals: ['TODO.md: 审核龙虾学校测试题/SKILL.md (PGT 改版)', '新版 summary.json 与 scorer.py 字段不兼容'],
      codeSnippets: [{ file: 'TODO.md', line: 8, content: '新版 summary.json 格式不兼容现有 scorer.py（缺少 token/lobster_name）' }],
    },
    impact: { estimatedFiles: ['app/scorer.py', 'public/SKILL.md', 'TODO.md'], estimatedLinesChanged: 80, blastRadius: 'cross_module' },
    verification: { method: 'PGT v1 SKILL.md 兼容评分', steps: ['分析新旧 summary.json 差异', '决定迁移方案', '重写 scorer.py 适配', '全题回归测试'], successCriteria: ['新旧格式均可评分', 'TODO.md 对应项完成'] },
    confidence: 0.55, risk_level: 'medium', suggested_at: now(), approved_at: null, completed_at: null,
    dismiss_reason: null, snooze_until: null, execution_id: null, created_at: now(), updated_at: now(),
  },
  {
    id: uuid(), repo_id: 'clawschool-001', signal_ids: ['s5'], type: 'todo_cleanup', status: 'suggested',
    title: '诊断流程 skill 生成失败降级为空数组，无重试或告警',
    description: 'Skill 生成失败时 generatedSkills 降级为空数组，没有重试机制、没有告警通知、没有失败率监控。US AI 服务调用 Claude Code 如果超时或失败，用户不会收到任何反馈。',
    evidence: {
      signals: ['CLAUDE.md: generatedSkills 降级为空数组', '/api/test/diagnose → US /api/generate-skills 调用链无容错'],
    },
    impact: { estimatedFiles: ['app/main.py', 'app/repair.py'], estimatedLinesChanged: 35, blastRadius: 'module' },
    verification: { method: '失败时用户看到提示', steps: ['加重试(最多2次)', '加超时告警', '返回 partial result 而非空'], successCriteria: ['skill 生成失败率可观测', '用户看到降级提示'] },
    confidence: 0.60, risk_level: 'low', suggested_at: now(), approved_at: null, completed_at: null,
    dismiss_reason: null, snooze_until: null, execution_id: null, created_at: now(), updated_at: now(),
  },
];

const executions: Execution[] = [];

// ── HTTP Server ──

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-github-event',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method!;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-github-event',
    });
    return res.end();
  }

  // Dashboard
  if (path === '/' && method === 'GET') {
    const html = readFileSync(join(__dirname, 'src', 'dashboard.html'), 'utf-8')
      .replace('http://localhost:3001', `http://localhost:${PORT}`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Health
  if (path === '/health') return json(res, { status: 'healthy', timestamp: now(), checks: { database: 'ok', redis: 'ok' } });
  if (path === '/ready') return json(res, { ready: true });

  // Repos
  if (path === '/api/v1/repos' && method === 'GET') return json(res, { repos });

  const repoMatch = path.match(/^\/api\/v1\/repos\/([^/]+)$/);
  if (repoMatch && method === 'GET') {
    const repo = repos.find(r => r.id === repoMatch[1]);
    return repo ? json(res, { repo }) : json(res, { error: 'Not found' }, 404);
  }

  // Settings
  const settingsMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/settings$/);
  if (settingsMatch && method === 'PATCH') {
    const repo = repos.find(r => r.id === settingsMatch[1]);
    if (repo) {
      const body = await readBody(req);
      Object.assign(repo.settings, body);
      repo.updated_at = now();
    }
    return json(res, { repo });
  }

  // Suggestions
  const sugMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/suggestions$/);
  if (sugMatch && method === 'GET') {
    const repoTasks = tasks.filter(t => t.repo_id === sugMatch[1] && t.status === 'suggested');
    return json(res, {
      suggestions: repoTasks.map(t => ({
        task: t,
        actions: {
          approveUrl: `/api/v1/tasks/${t.id}/action`,
          dismissUrl: `/api/v1/tasks/${t.id}/action`,
          snoozeUrl: `/api/v1/tasks/${t.id}/action`,
        },
      })),
    });
  }

  // Discover (no-op, data is pre-loaded)
  const discoverMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/discover$/);
  if (discoverMatch && method === 'POST') {
    return json(res, { tasks: tasks.filter(t => t.repo_id === discoverMatch[1]), count: tasks.filter(t => t.repo_id === discoverMatch[1]).length });
  }

  // Tasks list
  const tasksMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/tasks$/);
  if (tasksMatch && method === 'GET') {
    const repoTasks = tasks.filter(t => t.repo_id === tasksMatch[1]);
    return json(res, { tasks: repoTasks, count: repoTasks.length });
  }

  // Task detail
  const taskMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (taskMatch && method === 'GET') {
    const task = tasks.find(t => t.id === taskMatch[1]);
    return task ? json(res, { task }) : json(res, { error: 'Not found' }, 404);
  }

  // Task action
  const actionMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/action$/);
  if (actionMatch && method === 'POST') {
    const task = tasks.find(t => t.id === actionMatch[1]);
    if (!task) return json(res, { error: 'Not found' }, 404);

    const body = await readBody(req);

    if (body.action === 'approve') {
      task.status = 'executing';
      task.approved_at = now();
      const exec: Execution = {
        id: uuid(), task_id: task.id, repo_id: task.repo_id, status: 'running',
        agent_provider: 'claude_code', branch_name: `steward/${task.type}/${task.id.slice(0, 8)}`,
        pr_number: null, pr_url: null,
        logs: [
          { timestamp: now(), level: 'info', message: `Starting execution for: ${task.title}` },
          { timestamp: now(), level: 'info', message: `Repository: teamo-lab/clawschool` },
          { timestamp: now(), level: 'info', message: `Agent prompt constructed` },
          { timestamp: now(), level: 'info', message: `Cloning repo and analyzing code...` },
        ],
        started_at: now(), completed_at: null, created_at: now(),
      };
      task.execution_id = exec.id;
      executions.push(exec);

      // Simulate completion after 3s
      setTimeout(() => {
        exec.status = 'pr_created';
        exec.completed_at = now();
        exec.pr_url = `https://github.com/teamo-lab/clawschool/pull/${100 + Math.floor(Math.random() * 50)}`;
        exec.pr_number = parseInt(exec.pr_url.split('/').pop()!);
        exec.logs.push(
          { timestamp: now(), level: 'info', message: `Changes applied to ${task.impact.estimatedFiles.join(', ')}` },
          { timestamp: now(), level: 'info', message: `PR created: ${exec.pr_url}` },
        );
        task.status = 'pr_created';
      }, 3000);

      return json(res, { status: 'approved', execution: exec });
    }

    if (body.action === 'dismiss') {
      task.status = 'dismissed';
      task.dismiss_reason = body.reason || 'Dismissed from dashboard';
      task.updated_at = now();
      return json(res, { status: 'dismissed' });
    }

    if (body.action === 'snooze') {
      task.status = 'snoozed';
      task.snooze_until = body.snoozeUntil || new Date(Date.now() + 86400000).toISOString();
      task.updated_at = now();
      return json(res, { status: 'snoozed', until: task.snooze_until });
    }
  }

  // Task execution
  const execMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/execution$/);
  if (execMatch && method === 'GET') {
    const exec = executions.find(e => e.task_id === execMatch[1]);
    return exec ? json(res, { execution: exec }) : json(res, { error: 'Not found' }, 404);
  }

  // Executions list
  if (path === '/api/v1/executions' && method === 'GET') {
    return json(res, { executions });
  }

  // Stats
  const statsMatch = path.match(/^\/api\/v1\/repos\/([^/]+)\/stats$/);
  if (statsMatch && method === 'GET') {
    const repoTasks = tasks.filter(t => t.repo_id === statsMatch[1]);
    const statusMap: Record<string, number> = {};
    repoTasks.forEach(t => { statusMap[t.status] = (statusMap[t.status] || 0) + 1; });

    const suggested = repoTasks.length;
    const accepted = repoTasks.filter(t => ['approved', 'executing', 'pr_created', 'verified', 'merged'].includes(t.status)).length;
    const merged = statusMap['merged'] || 0;

    return json(res, {
      period: '30d',
      tasks: statusMap,
      executions: {},
      metrics: {
        acceptanceRate: suggested > 0 ? Math.round(accepted / suggested * 100) : 0,
        mergeRate: accepted > 0 ? Math.round(merged / accepted * 100) : 0,
        totalSuggested: suggested,
        totalAccepted: accepted,
        totalMerged: merged,
      },
    });
  }

  // Webhook
  if (path === '/api/v1/webhooks/github' && method === 'POST') {
    return json(res, { ok: true });
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  Repo Steward Dashboard                         ║
║  http://localhost:${PORT}                           ║
║                                                  ║
║  Repo: teamo-lab/clawschool                      ║
║  Tasks: ${tasks.length} suggestions ready                    ║
╚══════════════════════════════════════════════════╝
`);
});
