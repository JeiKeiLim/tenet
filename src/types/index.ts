export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export type JobType = 'dev' | 'eval' | 'critic_eval' | 'mechanical_eval' | 'integration_test' | 'compile_context' | 'health_check';

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
}

export interface JobWaitResponse {
  status: JobStatus;
  progress_line: string;
  cursor: string;
  is_terminal: boolean;
  elapsed_ms: number;
  job_name?: string;
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
  messages: SteerMessage[];
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
