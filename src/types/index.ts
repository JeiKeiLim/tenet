export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'blocked_on_finding';

export type JobType = 'dev' | 'eval' | 'critic_eval' | 'playwright_eval' | 'mechanical_eval' | 'integration_test' | 'compile_context' | 'health_check';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  params: Record<string, unknown>;
  agentName?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  lastHeartbeat?: number;
  retryCount: number;
  maxRetries: number;
  parentJobId?: string;
  error?: string;
  serverId?: string;
}

export type PendingReason =
  | 'queued_after_parent'
  | 'orphan_reset_after_stale_heartbeat'
  | 'retry_reset'
  | 'blocking_finding_resolved'
  | 'not_started'
  | 'unknown_pending';

export interface JobWaitResponse {
  job_id: string;
  job_type: JobType;
  status: JobStatus;
  progress_line: string;
  cursor: string;
  is_terminal: boolean;
  elapsed_ms: number;
  job_name?: string;
  parent_job_id?: string;
  server_id?: string;
  pending_reason?: PendingReason;
  recent_events: string[];
}

export interface JobResult {
  job_id: string;
  status: JobStatus;
  output: unknown;
  findings?: Record<string, unknown>;
  error?: string;
  duration_ms: number;
}

export interface ContinuationState {
  all_done: boolean;
  all_blocked: boolean;
  next_job?: Job;
  running_jobs?: Job[];
  blocked_jobs?: Job[];
  completed_count: number;
  total_count: number;
}

export type SteerMessageClass = 'context' | 'directive' | 'emergency';
export type SteerMessageStatus = 'received' | 'acknowledged' | 'acted_on' | 'resolved';
export type SteerSource = 'user' | 'agent';

export interface SteerMessage {
  id: string;
  timestamp: string;
  class: SteerMessageClass;
  content: string;
  status: SteerMessageStatus;
  source: SteerSource;
  agentResponse?: string;
  affectedJobIds?: string[];
}

export interface SteerResult {
  has_emergency: boolean;
  has_directive: boolean;
  /** All unresolved user steers — uncapped, so human input is never crowded out. */
  user_messages: SteerMessage[];
  /** Most-recent-`limit` unresolved agent steers. */
  agent_messages: SteerMessage[];
  /** True unresolved counts per source (independent of the agent cap). */
  total_unresolved: { user: number; agent: number };
  /** How many were actually returned per source this call. */
  returned: { user: number; agent: number };
  /** True when the agent bucket was capped — there are more agent steers than returned. */
  truncated: boolean;
}

export interface HealthReport {
  healthy: boolean;
  server_uptime_ms: number;
  active_jobs: number;
  orphaned_files: string[];
  stale_documents: string[];
  missing_updates: string[];
  broken_references: string[];
  unacknowledged_steers: number;
}

export interface ProjectStatus {
  project_path: string;
  mode: 'full' | 'standard' | 'quick' | 'unset';
  jobs_completed: number;
  jobs_remaining: number;
  jobs_blocked: number;
  current_job?: string;
  elapsed_ms: number;
  last_activity: string;
}

export type ConfidenceTag =
  | 'implemented-and-tested'
  | 'implemented-not-tested'
  | 'decision-only'
  | 'scanned-not-verified';

export interface AgentAdapterConfig {
  name: string;
  command: string;
  mode: 'cli' | 'sdk';
  available: boolean;
}

export interface TenetConfig {
  agents: {
    default: string;
    fallback?: string;
    overrides?: Record<JobType, string>;
  };
  concurrency: {
    max_parallel_agents: number;
  };
}
