// ── Core domain types for Repo Steward ──

export type TaskType =
  | 'ci_fix' | 'deploy_fix' | 'todo_cleanup' | 'test_gap' | 'dependency_upgrade'
  | 'code_quality' | 'security_fix' | 'perf_improvement' | 'dead_code' | 'config_drift'
  | 'doc_gap' | 'error_handling' | 'type_safety';
export type TaskStatus = 'discovered' | 'suggested' | 'approved' | 'executing' | 'pr_created' | 'verified' | 'merged' | 'dismissed' | 'snoozed' | 'failed';
export type RiskLevel = 'low' | 'medium' | 'high';
export type UserAction = 'approve' | 'dismiss' | 'snooze';
export type SignalType = 'ci_failure' | 'deploy_failure' | 'todo_comment' | 'test_coverage_gap' | 'stale_issue';
export type NotificationChannel = 'slack' | 'email' | 'github';

export interface Repo {
  id: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  installationId: number;
  defaultBranch: string;
  language: string | null;
  isActive: boolean;
  settings: RepoSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepoSettings {
  maxDailySuggestions: number;       // default 3
  enabledTaskTypes: TaskType[];
  notificationChannels: NotificationChannel[];
  slackWebhookUrl?: string;
  emailRecipients?: string[];
  autoApproveTypes?: TaskType[];     // tasks to auto-approve (empty by default)
  excludePaths?: string[];           // glob patterns to exclude
  confidenceThreshold: number;       // 0-1, default 0.75
}

export interface Signal {
  id: string;
  repoId: string;
  type: SignalType;
  source: string;                    // e.g. "github_actions", "vercel", "code_scan"
  rawPayload: Record<string, unknown>;
  extractedData: ExtractedSignalData;
  processedAt: Date | null;
  createdAt: Date;
}

export interface ExtractedSignalData {
  title: string;
  description: string;
  filePaths?: string[];
  errorMessage?: string;
  logUrl?: string;
  severity?: 'critical' | 'warning' | 'info';
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  repoId: string;
  signalIds: string[];               // signals that triggered this task
  type: TaskType;
  status: TaskStatus;
  title: string;
  description: string;
  evidence: TaskEvidence;
  impact: TaskImpact;
  verification: TaskVerification;
  confidence: number;                // 0-1
  riskLevel: RiskLevel;
  suggestedAt: Date | null;
  approvedAt: Date | null;
  completedAt: Date | null;
  dismissReason?: string;
  snoozeUntil?: Date;
  executionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskEvidence {
  signals: string[];                 // human-readable evidence lines
  logSnippets?: string[];
  codeSnippets?: Array<{ file: string; line: number; content: string }>;
  relatedPRs?: string[];
  relatedIssues?: string[];
}

export interface TaskImpact {
  estimatedFiles: string[];
  estimatedLinesChanged: number;
  affectedServices?: string[];
  blastRadius: 'isolated' | 'module' | 'cross_module' | 'system_wide';
}

export interface TaskVerification {
  method: string;                    // e.g. "CI passes", "deploy succeeds", "tests pass"
  steps: string[];
  successCriteria: string[];
  rollbackPlan?: string;
}

export interface Execution {
  id: string;
  taskId: string;
  repoId: string;
  status: 'queued' | 'running' | 'pr_created' | 'verified' | 'failed' | 'cancelled';
  agentProvider: 'claude_code' | 'codex';
  branchName: string;
  prNumber?: number;
  prUrl?: string;
  agentSessionId?: string;
  logs: ExecutionLog[];
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface ExecutionLog {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
}

export interface User {
  id: string;
  githubId: number;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
  accessToken: string;               // encrypted
  refreshToken: string | null;       // encrypted
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  members: TeamMember[];
  repos: string[];                   // repo IDs
  plan: 'free' | 'pro' | 'enterprise';
  createdAt: Date;
}

export interface TeamMember {
  userId: string;
  role: 'owner' | 'admin' | 'member';
  addedAt: Date;
}

// ── API types ──

export interface SuggestionResponse {
  task: Task;
  actions: {
    approveUrl: string;
    dismissUrl: string;
    snoozeUrl: string;
  };
}

export interface DailyDigest {
  date: string;
  repoId: string;
  suggestions: SuggestionResponse[];
  stats: {
    totalDiscovered: number;
    filteredByConfidence: number;
    suggestedCount: number;
  };
}

export interface TaskActionRequest {
  action: UserAction;
  reason?: string;                   // required for dismiss
  snoozeUntil?: string;              // ISO date, required for snooze
}

// ── GitHub webhook types ──

export interface GitHubCheckRunEvent {
  action: 'completed';
  check_run: {
    id: number;
    name: string;
    conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | null;
    output: {
      title: string | null;
      summary: string | null;
      text: string | null;
    };
    html_url: string;
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: {
    id: number;
  };
}

export interface GitHubDeploymentStatusEvent {
  action: 'created';
  deployment_status: {
    state: 'error' | 'failure' | 'inactive' | 'pending' | 'success';
    description: string | null;
    log_url: string | null;
  };
  deployment: {
    ref: string;
    environment: string;
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: {
    id: number;
  };
}
