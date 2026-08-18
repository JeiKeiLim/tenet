import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ContinuationState, Job, JobResult, JobType, JobWaitResponse, PendingReason } from '../types/index.js';
import { AdapterRegistry } from '../adapters/index.js';
import type { AgentAdapter, AgentInvocation } from '../adapters/base.js';
import {
  formatMaxRetries,
  hasRetryBudgetRemaining,
  parseMaxRetries,
  parseTimeoutMinutes,
} from './runtime-config.js';
import { StateStore } from './state-store.js';
import { DEFAULT_EVAL_STAGES } from './critic-roster.js';
import { readArtifactFile, type ArtifactPaths } from './artifact-paths.js';
import { extractRubricJson } from './rubric.js';

/**
 * Extract a typed {@link ArtifactPaths} from an untyped `job.params.artifact_paths`
 * value. Returns undefined for missing/non-object values so the worker-context
 * builder degrades gracefully for legacy/quick jobs that carry no exact paths.
 */
const getJobArtifactPaths = (value: unknown): ArtifactPaths | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as ArtifactPaths;
};

/**
 * Read an artifact file for the worker, degrading to empty string if the path dangles.
 * Unlike the strict {@link readArtifactFile} used at registration (which throws to fail
 * fast on a bad path), the worker dispatch path must not crash a whole job because one
 * doc is missing post-migration — partial context beats blocking the job.
 */
const safeReadArtifact = (projectPath: string, relativePath: string, label: string): string => {
  try {
    return readArtifactFile(projectPath, relativePath, label);
  } catch {
    return '';
  }
};

/**
 * Report-Only Scope block — worker-bound instructions for report-only jobs. Lives in the
 * worker dispatch path (not `tenet_compile_context`) because it must reach the worker
 * subprocess, which never sees compile_context output.
 */
const reportOnlyScopeLines = (jobId: string): string[] => [
  '## Report-Only Scope',
  '',
  'You are in REPORT-ONLY mode. You MUST NOT edit project files (other than writing your final report).',
  '',
  'If verification reveals a blocking finding that must be resolved before this report can be trustworthy:',
  '',
  `1. Call \`tenet_report_blocking_finding({ job_id: "${jobId}", finding, why_it_blocks_report, recommended_followup, suspected_files })\`.`,
  '2. Your job will be paused (status: blocked_on_finding).',
  '3. A linked child dev job will investigate/resolve the finding and pass its own evals.',
  '4. Your job will auto-resume with fresh context once the finding is resolved.',
  '',
  'Do NOT edit files yourself. Do NOT silently work around the bug. Do NOT abandon the report.',
];

type JobManagerConfig = {
  maxParallelAgents?: number;
  heartbeatTimeoutMs?: number;
  defaultJobTimeoutMs?: number;
  serverId?: string;
};

const TERMINAL_STATUSES = new Set<Job['status']>(['completed', 'failed', 'cancelled']);

/**
 * Window for grouping legacy (unstamped) eval critics into "cohorts" in the
 * per-stage fallback gate. A full re-evaluation dispatches all critics
 * synchronously (ms apart); a single ad-hoc re-fire via tenet_start_job is a
 * separate dispatch created later. The newest critic per stage must be created
 * within this window of the completing critic, or the round is a partial
 * re-evaluation and the gate stays closed. Kept small (1s) to narrow the
 * blind spot for re-fires created shortly after the round — a heuristic, since
 * the per-stage path has no round ids to distinguish a full re-evaluation from
 * a partial re-fire.
 */
const COHORT_WINDOW_MS = 1_000;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class JobManager {
  private readonly stateStore: StateStore;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly maxParallelAgents: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly defaultJobTimeoutMs: number;
  private readonly serverId: string;

  constructor(stateStore: StateStore, adapterRegistry: AdapterRegistry, config?: JobManagerConfig) {
    this.stateStore = stateStore;
    this.adapterRegistry = adapterRegistry;
    this.maxParallelAgents = config?.maxParallelAgents ?? 4;
    this.heartbeatTimeoutMs = config?.heartbeatTimeoutMs ?? 30 * 60 * 1000;
    this.defaultJobTimeoutMs = config?.defaultJobTimeoutMs ?? 30_000;
    this.serverId = config?.serverId ?? crypto.randomUUID();

    // Reset only stale jobs left "running" by a previous server instance.
    // A different server_id alone is not enough: nested MCP clients can start
    // while the owning server is still alive and heartbeating the job.
    const resetCount = this.stateStore.resetOrphanedJobs(this.serverId, this.heartbeatTimeoutMs);
    if (resetCount > 0) {
      this.stateStore.appendEvent('system', 'orphaned_jobs_reset', {
        count: resetCount,
        server_id: this.serverId,
      });
    }
  }

  dispatchJob(jobId: string): Job {
    const job = this.stateStore.getJob(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }

    if (job.status === 'running') {
      // Idempotent: already dispatched (e.g. a concurrent retry from another
      // server process won the race). Return the running job as-is.
      return job;
    }

    if (job.status !== 'pending') {
      throw new Error(`job ${jobId} is ${job.status}, expected pending`);
    }

    const now = Date.now();
    // Atomic pending -> running: only one process can win. If another process
    // dispatched it between our read and this update, return the current job
    // instead of double-executing.
    if (!this.stateStore.markJobRunning(jobId, now, this.resolveAgentName(job.type))) {
      const current = this.stateStore.getJob(jobId);
      if (!current) {
        throw new Error(`failed to load dispatched job: ${jobId}`);
      }
      return current;
    }
    this.stateStore.setJobServerId(jobId, this.serverId);
    this.stateStore.appendEvent(jobId, 'job_started', { type: job.type });

    setTimeout(() => {
      this.executeJob(jobId).catch(() => {
        // executeJob handles its own errors via job status; swallow any late failures
        // (e.g. state-store closed during test teardown) to avoid unhandled rejections.
      });
    }, 0);

    const updated = this.stateStore.getJob(jobId);
    if (!updated) {
      throw new Error(`failed to load dispatched job: ${jobId}`);
    }

    return updated;
  }

  private getMaxRetries(): number {
    return parseMaxRetries(this.stateStore.getConfig('max_retries'));
  }

  createPendingJob(type: JobType, params: Record<string, unknown>, parentJobId?: string): Job {
    if (!params.name || typeof params.name !== 'string') {
      params = { ...params, name: `${type}-${Date.now().toString(36)}` };
    }

    const job = this.stateStore.createJob({
      type,
      status: 'pending',
      params,
      agentName: this.resolveAgentName(type),
      retryCount: 0,
      maxRetries: this.getMaxRetries(),
      parentJobId,
    });

    return job;
  }

  startJob(type: JobType, params: Record<string, unknown>): Job {
    // Ensure every job has a human-readable name
    if (!params.name || typeof params.name !== 'string') {
      const sourceJobId = typeof params.source_job_id === 'string' ? params.source_job_id : undefined;
      const evalStage = typeof params.eval_stage === 'string' ? params.eval_stage : undefined;
      if (sourceJobId && evalStage) {
        const sourceJob = this.stateStore.getJob(sourceJobId);
        const sourceName = sourceJob && typeof sourceJob.params.name === 'string'
          ? sourceJob.params.name : sourceJobId.slice(0, 8);
        params = { ...params, name: `${evalStage} for ${sourceName}` };
      } else {
        params = { ...params, name: `${type}-${Date.now().toString(36)}` };
      }
    }

    const job = this.stateStore.createJob({
      type,
      status: 'pending',
      params,
      agentName: this.resolveAgentName(type),
      retryCount: 0,
      maxRetries: this.getMaxRetries(),
    });

    const now = Date.now();
    this.stateStore.updateJob(job.id, {
      status: 'running',
      startedAt: now,
      lastHeartbeat: now,
    });
    this.stateStore.setJobServerId(job.id, this.serverId);
    this.stateStore.appendEvent(job.id, 'job_started', { type });

    setTimeout(() => {
      this.executeJob(job.id).catch(() => {
        // See setTimeout in dispatchJob for rationale
      });
    }, 0);

    const created = this.stateStore.getJob(job.id);
    if (!created) {
      throw new Error(`failed to load created job: ${job.id}`);
    }

    return created;
  }

  checkJobStatus(jobId: string, cursor: string | null): JobWaitResponse {
    this.detectStalledJobs();

    const job = this.stateStore.getJob(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }

    const { currentCursor, events } = this.collectJobEvents(jobId, cursor);
    return this.buildJobWaitResponse(job, currentCursor, events);
  }

  async waitForJob(jobId: string, cursor: string | null, timeoutMs: number): Promise<JobWaitResponse> {
    const startedAt = Date.now();
    const timeout = timeoutMs > 0 ? timeoutMs : this.defaultJobTimeoutMs;
    let currentCursor = cursor ?? '0';

    for (;;) {
      this.detectStalledJobs();

      const job = this.stateStore.getJob(jobId);
      if (!job) {
        throw new Error(`job not found: ${jobId}`);
      }

      const collected = this.collectJobEvents(jobId, currentCursor);
      currentCursor = collected.currentCursor;
      const response = this.buildJobWaitResponse(job, currentCursor, collected.events);

      if (TERMINAL_STATUSES.has(job.status)) {
        return response;
      }

      if (Date.now() - startedAt >= timeout) {
        return response;
      }

      await sleep(500);
    }
  }

  getJobResult(jobId: string): JobResult {
    const job = this.stateStore.getJob(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }

    const end = job.completedAt ?? Date.now();
    const duration = Math.max(0, end - job.createdAt);

    return {
      job_id: job.id,
      status: job.status,
      output: this.stateStore.getJobOutput(jobId),
      error: job.error,
      duration_ms: duration,
    };
  }

  cancelJob(jobId: string): void {
    const job = this.stateStore.getJob(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      return;
    }

    this.stateStore.updateJob(jobId, {
      status: 'cancelled',
      completedAt: Date.now(),
      error: 'cancelled by user',
    });
    this.stateStore.appendEvent(jobId, 'job_cancelled');
  }

  retryJob(jobId: string, enhancedPrompt?: string): Job {
    const job = this.stateStore.getJob(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
      throw new Error(`job ${jobId} is ${job.status}, can only retry completed or failed jobs`);
    }

    // A completed-job re-run is an intentional re-run, not a failure retry: it
    // resets retry_count to 0 (resetJobForRetry) and never consumes the budget, so
    // the budget gate does not apply. A failed-job retry consumes the budget.
    if (job.status !== 'completed' && !hasRetryBudgetRemaining(job.retryCount, job.maxRetries)) {
      throw new Error(
        `job ${jobId} has exhausted retries (${job.retryCount}/${formatMaxRetries(job.maxRetries)})`,
      );
    }

    const params = { ...job.params };
    if (enhancedPrompt) {
      params.prompt = enhancedPrompt;
    }

    // Atomic conditional reset: only one process can win the completed/failed ->
    // pending transition. If another MCP server process already retried this job,
    // return its current state without dispatching (idempotent).
    if (!this.stateStore.resetJobForRetry(jobId, params)) {
      const current = this.stateStore.getJob(jobId);
      if (!current) {
        throw new Error(`failed to load retried job: ${jobId}`);
      }
      return current;
    }

    // A completed job is an intentional re-run (retry_count resets to 0); a failed
    // job is a failure retry (retry_count increments). Mirrors resetJobForRetry.
    const newRetryCount = job.status === 'completed' ? 0 : job.retryCount + 1;
    this.stateStore.appendEvent(jobId, 'job_retried', {
      retry_count: newRetryCount,
      has_enhanced_prompt: !!enhancedPrompt,
    });

    // Retry is an explicit "run it again now" action: dispatch immediately rather
    // than leaving the job pending for a poller that doesn't exist. Without this, a
    // retried job (and everything chained behind it) wedges at pending/retry_reset
    // forever — there is no background dispatch loop, and the chain event that first
    // started the job already fired. dispatchJob is idempotent on running, so a
    // concurrent dispatch from another process is safe.
    return this.dispatchJob(jobId);
  }

  continue(): ContinuationState {
    this.detectStalledJobs();
    const nextJob = this.stateStore.getNextRunnableJob();
    const blockedJobs = this.stateStore.getBlockedJobs();
    const runningJobs = this.stateStore.getJobsByStatus('running');
    const totalCount = this.stateStore.getTotalCount();
    const completedCount = this.stateStore.getCompletedCount();

    return {
      all_done: totalCount > 0 && completedCount === totalCount,
      all_blocked: !nextJob && runningJobs.length === 0 && blockedJobs.length > 0,
      next_job: nextJob ?? undefined,
      running_jobs: runningJobs.length > 0 ? runningJobs : undefined,
      blocked_jobs: blockedJobs.length > 0 ? blockedJobs : undefined,
      completed_count: completedCount,
      total_count: totalCount,
    };
  }

  getActiveConcurrency(): number {
    const running = this.stateStore.getJobsByStatus('running').length;
    return Math.min(running, this.maxParallelAgents);
  }

  async shutdown(): Promise<void> {
    this.detectStalledJobs();
  }

  /** Heartbeat staleness threshold (ms) — a running job whose last heartbeat is older than this is stale. */
  getHeartbeatTimeoutMs(): number {
    return this.heartbeatTimeoutMs;
  }

  private detectStalledJobs(): void {
    const now = Date.now();
    this.stateStore.resetOrphanedJobs(this.serverId, this.heartbeatTimeoutMs);
    const activeJobs = this.stateStore.getJobsByStatus('running');
    for (const job of activeJobs) {
      if (!job.lastHeartbeat) {
        continue;
      }

      if (now - job.lastHeartbeat <= this.heartbeatTimeoutMs) {
        continue;
      }

      this.stateStore.updateJob(job.id, {
        status: 'failed',
        completedAt: now,
        error: 'stall detected',
      });
      this.stateStore.appendEvent(job.id, 'job_failed', { error: 'stall detected' });
    }
  }

  private resolveAgentName(type: JobType): string | undefined {
    const typeOverride = this.stateStore.getConfig(`agent_override_${type}`);
    if (typeOverride) {
      return typeOverride;
    }

    return this.stateStore.getConfig('default_agent') ?? undefined;
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.stateStore.getJob(jobId);
    if (!job || job.status !== 'running') {
      return;
    }

    this.stateStore.setJobServerId(jobId, this.serverId);

    const heartbeatTimer = setInterval(() => {
      const current = this.stateStore.getJob(jobId);
      if (!current || TERMINAL_STATUSES.has(current.status)) {
        return;
      }

      this.stateStore.updateJob(jobId, {
        lastHeartbeat: Date.now(),
      });
    }, 2_000);

    try {
      const adapter = await this.selectAdapter(job.agentName);

      if (!adapter) {
        const available = await this.adapterRegistry.listAvailable();
        const availableNames = available.filter((a) => a.available).map((a) => a.name);
        const allNames = available.map((a) => `${a.name}(${a.available ? 'available' : 'unavailable'})`);
        const requestedAgent =
          job.agentName && job.agentName !== 'default'
            ? job.agentName
            : this.stateStore.getConfig('default_agent');

        const stubOutput = {
          message: requestedAgent
            ? `Configured agent adapter "${requestedAgent}" is not available to execute this job.`
            : 'No Tenet agent is configured to execute this job.',
          tried_agent: requestedAgent ?? null,
          adapters: allNames,
          available_adapters: availableNames,
          hint: requestedAgent
            ? `Install or authenticate "${requestedAgent}", or choose a different agent explicitly with tenet config --agent <name>. Tenet will not switch agents automatically.`
            : 'Set an agent explicitly with tenet config --agent <name>. Tenet will not pick an installed CLI automatically.',
          type: job.type,
          params: job.params,
        };

        const finishedAt = Date.now();
        this.stateStore.setJobOutput(jobId, stubOutput);
        if (this.preserveBlockedFindingParent(jobId)) {
          return;
        }
        this.stateStore.updateJob(jobId, {
          status: 'failed',
          completedAt: finishedAt,
          lastHeartbeat: finishedAt,
          error: 'no agent adapter available',
        });
        this.stateStore.appendEvent(jobId, 'job_failed', { error: 'no agent adapter available', output: stubOutput });
        return;
      }

      const invocation = this.toInvocation(job, adapter.name);
      const response = await adapter.invoke(invocation);
      const finishedAt = Date.now();

      this.stateStore.setJobOutput(jobId, {
        adapter: adapter.name,
        output: response.output,
        duration_ms: response.durationMs,
      });

      if (this.preserveBlockedFindingParent(jobId)) {
        return;
      }

      if (response.success) {
        // For dev jobs, verify the worker actually produced file changes
        if (job.type === 'dev') {
          const deliverableCheck = this.checkDeliverables(job);
          if (!deliverableCheck.passed) {
            this.stateStore.updateJob(jobId, {
              status: 'failed',
              completedAt: finishedAt,
              lastHeartbeat: finishedAt,
              error: deliverableCheck.reason,
            });
            this.stateStore.appendEvent(jobId, 'job_failed', {
              adapter: adapter.name,
              error: deliverableCheck.reason,
              duration_ms: response.durationMs,
              deliverable_check: 'failed',
            });
            return;
          }
        }

        this.stateStore.updateJob(jobId, {
          status: 'completed',
          completedAt: finishedAt,
          lastHeartbeat: finishedAt,
          // Completion clears the failure streak: a later failure gets a fresh
          // retry budget, and re-running a completed job never accumulates
          // retryCount (intentional re-runs are not failure retries).
          retryCount: 0,
        });
        this.stateStore.appendEvent(jobId, 'job_completed', {
          adapter: adapter.name,
          duration_ms: response.durationMs,
        });

        this.persistReadinessVerdict(job, response.output);
        this.dispatchChainedChildren(jobId);
        this.checkBlockingFindingResume(job, response.output);
        return;
      }

      this.stateStore.updateJob(jobId, {
        status: 'failed',
        completedAt: finishedAt,
        lastHeartbeat: finishedAt,
        error: response.error ?? 'agent invocation failed',
      });
      this.stateStore.appendEvent(jobId, 'job_failed', {
        adapter: adapter.name,
        error: response.error ?? 'agent invocation failed',
      });
    } catch (error) {
      const finishedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (this.preserveBlockedFindingParent(jobId)) {
        return;
      }
      this.stateStore.updateJob(jobId, {
        status: 'failed',
        completedAt: finishedAt,
        lastHeartbeat: finishedAt,
        error: message,
      });
      this.stateStore.appendEvent(jobId, 'job_failed', { error: message });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async selectAdapter(agentName?: string): Promise<AgentAdapter | null> {
    const requestedAgent =
      agentName && agentName !== 'default'
        ? agentName
        : this.stateStore.getConfig('default_agent');

    if (!requestedAgent) {
      return null;
    }

    const adapter = this.adapterRegistry.get(requestedAgent);
    if (!adapter || !(await adapter.isAvailable())) {
      return null;
    }

    return adapter;
  }

  private collectJobEvents(
    jobId: string,
    cursor: string | null,
  ): { currentCursor: string; events: Array<{ id: string; jobId: string; event: string; data: unknown; timestamp: number }> } {
    let currentCursor = cursor ?? '0';
    const events = this.stateStore
      .getEventsSince(currentCursor)
      .filter((event) => event.jobId === jobId);
    if (events.length > 0) {
      currentCursor = events[events.length - 1].id;
    }
    return { currentCursor, events };
  }

  private buildJobWaitResponse(
    job: Job,
    cursor: string,
    events: Array<{ id: string; jobId: string; event: string; data: unknown; timestamp: number }>,
  ): JobWaitResponse {
    const jobName = typeof job.params.name === 'string' ? job.params.name : undefined;
    const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
    const recentEvents = events.slice(-5).map((e) => e.event);
    const isTerminal = TERMINAL_STATUSES.has(job.status);

    return {
      job_id: job.id,
      job_type: job.type,
      status: job.status,
      progress_line: isTerminal
        ? this.progressLine(job.status)
        : `${this.progressLine(job.status)} (${Math.round(elapsed / 1000)}s elapsed)`,
      cursor,
      is_terminal: isTerminal,
      elapsed_ms: elapsed,
      job_name: jobName,
      parent_job_id: job.parentJobId,
      server_id: job.serverId,
      pending_reason: this.pendingReason(job),
      recent_events: recentEvents,
    };
  }

  private pendingReason(job: Job): PendingReason | undefined {
    if (job.status !== 'pending') {
      return undefined;
    }

    if (job.parentJobId) {
      const parent = this.stateStore.getJob(job.parentJobId);
      if (parent && parent.status !== 'completed') {
        return 'queued_after_parent';
      }
    }

    const events = this.stateStore.getEventsForJob(job.id, 100).slice().reverse();
    for (const event of events) {
      if (event.event === 'job_orphan_reset') {
        return 'orphan_reset_after_stale_heartbeat';
      }
      if (event.event === 'job_retried') {
        return 'retry_reset';
      }
      if (event.event === 'blocking_finding_resolved') {
        return 'blocking_finding_resolved';
      }
    }

    if (!job.startedAt) {
      return 'not_started';
    }

    return 'unknown_pending';
  }

  private preserveBlockedFindingParent(jobId: string): boolean {
    const current = this.stateStore.getJob(jobId);
    if (current?.status !== 'blocked_on_finding') {
      return false;
    }

    this.stateStore.appendEvent(jobId, 'blocked_finding_parent_exit_preserved');
    return true;
  }

  private toInvocation(job: Job, adapterName: string): AgentInvocation {
    const rawPrompt = typeof job.params.prompt === 'string' ? job.params.prompt : `Execute ${job.type} job ${job.id}`;
    const prompt = job.type === 'dev'
      ? this.withDevPreamble(rawPrompt, job)
      : job.type === 'integration_test'
        ? this.withIntegrationTestPreamble(rawPrompt, job)
        : rawPrompt;
    const context = this.buildWorkerContext(job);

    const maxTurnsRaw = job.params.maxTurns;
    const maxTurns =
      typeof maxTurnsRaw === 'number' && Number.isFinite(maxTurnsRaw)
        ? Math.max(1, Math.floor(maxTurnsRaw))
        : undefined;

    const workdir = typeof job.params.workdir === 'string' ? job.params.workdir : this.stateStore.projectPath;

    const configuredTimeout = parseTimeoutMinutes(this.stateStore.getConfig('timeout_minutes'));
    const timeoutMs = configuredTimeout ? configuredTimeout * 60 * 1000 : undefined;

    // The interaction-e2e critic gets the Playwright MCP tool allowlist so it can
    // drive a browser when the surface is web_ui/visual. CLI/API/library surfaces
    // simply don't use them.
    const allowedTools = job.type === 'interaction_e2e'
      ? [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
          'mcp__playwright__browser_navigate',
          'mcp__playwright__browser_navigate_back',
          'mcp__playwright__browser_click',
          'mcp__playwright__browser_type',
          'mcp__playwright__browser_fill_form',
          'mcp__playwright__browser_snapshot',
          'mcp__playwright__browser_take_screenshot',
          'mcp__playwright__browser_wait_for',
          'mcp__playwright__browser_press_key',
          'mcp__playwright__browser_select_option',
          'mcp__playwright__browser_hover',
          'mcp__playwright__browser_drag',
          'mcp__playwright__browser_resize',
          'mcp__playwright__browser_tabs',
          'mcp__playwright__browser_close',
          'mcp__playwright__browser_console_messages',
          'mcp__playwright__browser_network_requests',
          'mcp__playwright__browser_evaluate',
          'mcp__playwright__browser_run_code',
          'mcp__playwright__browser_file_upload',
          'mcp__playwright__browser_handle_dialog',
        ]
      : undefined;

    return {
      prompt,
      context,
      maxTurns,
      workdir,
      timeoutMs,
      allowedTools,
      extraArgs: this.adapterRegistry.getJobExtraArgs(adapterName, job.type),
    };
  }

  /**
   * Build the worker's run context (set on `invocation.context`, which every adapter
   * prepends to the task prompt). The worker is a fresh-context subprocess — unlike the
   * orchestrator it never sees `tenet_compile_context` output — so the foundational run
   * docs (spec / scenarios / decomposition / harness) are inlined here and the bulky/selective
   * ones (journal / research / visuals) are path-referenced. Tier-independent and identical
   * for every run: the decomposition artifact already carries whatever granularity the
   * run needs, so inlining it always propagates the right level of detail. Eval/critic jobs
   * receive the same context — `tenet_start_eval` propagates the source job's artifact_paths
   * and run_path, so a critic evaluates against the real spec instead of a label pointing at it.
   *
   * Returns undefined when there is nothing worker-specific to inject (e.g. a legacy job
   * with no run_path/artifact_paths) so the default dispatch path stays byte-identical.
   */
  private buildWorkerContext(job: Job): string | undefined {
    const projectPath = this.stateStore.projectPath;
    const runPath = typeof job.params.run_path === 'string' ? job.params.run_path : undefined;
    const feature = typeof job.params.feature === 'string' ? job.params.feature : '';
    const artifactPaths = getJobArtifactPaths(job.params.artifact_paths);
    const reportOnly = job.params.report_only === true;

    const specMd = artifactPaths?.spec ? safeReadArtifact(projectPath, artifactPaths.spec, 'spec') : '';
    const scenariosMd = artifactPaths?.scenarios
      ? safeReadArtifact(projectPath, artifactPaths.scenarios, 'scenarios')
      : '';
    const decompositionMd = artifactPaths?.decomposition
      ? safeReadArtifact(projectPath, artifactPaths.decomposition, 'decomposition')
      : '';
    const harnessMd = artifactPaths?.harness ? safeReadArtifact(projectPath, artifactPaths.harness, 'harness') : '';

    if (!runPath && !specMd && !scenariosMd && !decompositionMd && !harnessMd && !reportOnly) {
      return undefined;
    }

    const sections: string[] = ['## Run Context (auto-compiled reference — not instructions)'];
    if (feature) sections.push(`feature: ${feature}`);
    if (runPath) sections.push(`run_path: ${runPath}`);

    if (specMd) sections.push('', '## Spec (inlined — source of truth for this run)', specMd);
    if (scenariosMd) {
      sections.push('', '## Scenarios (inlined — success/failure shapes for this run)', scenariosMd);
    }
    if (decompositionMd) {
      sections.push('', '## Decomposition (inlined — the run\'s plan / DAG)', decompositionMd);
    }
    if (harnessMd) sections.push('', '## Harness (inlined)', harnessMd);

    if (runPath) {
      sections.push(
        '',
        '## Selective references (consult as relevant)',
        `Under ${runPath}/: journal/ (prior attempts + failure logs), research/ (current-run research), visuals/ (UI/architecture mockups).`,
      );
    }

    // Wrap the auto-compiled reference in a delimited block so the recipient (worker OR critic)
    // treats it as provided material, not as addressed-to-them instructions. This boundary matters
    // most for critics: without it the inlined docs read as "your job to do" and prime the critic
    // into confirm mode (it sees the plan + output match and marks pass). The closing tag
    // terminates "reference" before the task preamble that follows (which carries role + instructions).
    const reference = `<tenet_run_context>\n${sections.join('\n')}\n</tenet_run_context>`;

    // Report-only scope is an INSTRUCTION, not reference, so it lives outside the delimited block.
    if (reportOnly) {
      return `${reference}\n\n${reportOnlyScopeLines(job.id).join('\n')}`;
    }

    return reference;
  }

  private withDevPreamble(prompt: string, job: Job): string {
    const feature = typeof job.params.feature === 'string' ? job.params.feature : '';
    const jobName = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
    const runPath = typeof job.params.run_path === 'string' ? job.params.run_path : undefined;
    const journalPath = runPath ? `${runPath}/journal/` : '.tenet/journal/';
    const projectDoctrineAuthorized = job.params.allow_project_doctrine_edits === true;
    const retryNote = job.retryCount > 0
      ? [
          '',
          `This is retry #${job.retryCount}. The previous attempt failed.`,
          `BEFORE starting work, check ${journalPath} for failure logs matching this job.`,
          `Look for files like: *-${jobName.toLowerCase().replace(/\s+/g, '-')}*trial*.md`,
          feature ? `Or search for: *-${feature}*trial*.md` : '',
          'Read them to understand what was tried and why it failed. Do NOT repeat the same approach.',
          '',
        ].filter(Boolean).join('\n')
      : '';

    return [
      '## Deliverable Requirements',
      '',
      'You are a worker agent executing a development job. You MUST produce concrete deliverables:',
      'If a <tenet_run_context> block appears above, read it first — it is the source of truth for this job; do not work blind from the task text alone.',
      '- Write or modify source code files that implement the described feature',
      '- Ensure the code compiles/passes type-checking',
      '- Run existing tests to verify no regressions',
      '- If acceptance tests exist (tests/acceptance/ or similar), run them and fix any failures related to your work',
      '- Write BEHAVIORAL tests that verify observable outcomes (e.g., "login returns session cookie and redirects to dashboard")',
      '- Do NOT write tests that only check absence of errors or internal state — a separate test critic will reject them',
      '- Every new endpoint, page, or feature MUST have at least one test that verifies it works correctly',
      '- Do NOT just explore, research, or describe what could be done — actually implement it',
      ...(projectDoctrineAuthorized
        ? ['- This job is explicitly authorized to edit `.tenet/project/**` project doctrine.']
        : [
            '- Do NOT edit `.tenet/project/**`. If you discover project doctrine (`.tenet/project/**`) is missing, stale, or wrong, record a **doctrine-drift note** — do NOT patch doctrine directly.',
            '- Write the drift note to the run journal via `tenet_update_knowledge(type="journal", title="doctrine drift: <file>", findings={"doctrine_file": "<e.g. project/architecture.md>", "current_claim": "<what doctrine currently says>", "observed_reality": "<what the code or run actually shows>", "proposed_change": "<the specific edit that brings doctrine back in line>"})`.',
            '- ALSO drop a `### doctrine-drift: <file>` marker at the spot in the run doc (e.g. `design.md`) where you note the drift inline, so the run-end review finds it even when written freeform. One note per affected doctrine file; the review dedupes by `doctrine_file`.',
          ]),
      '',
      '## Smoke Check (mandatory before exiting)',
      '- If this is a server/API feature: start the server, verify your endpoints respond (non-5xx)',
      '- If this is a frontend feature: start the dev server, verify pages render without errors',
      '- If smoke check fails, fix the issue before exiting',
      '',
      '## Git Commit (mandatory before exiting, if .git/ exists)',
      '- Stage all files you changed, including relevant `.tenet` documents you created or edited (use `git add` with specific paths, NOT `git add -A`)',
      '- Commit with message: `tenet({job-name}): {short description of what was done}`',
      '- Include the commit SHA in your final output',
      '- If you cannot commit, explain why in your final output and leave the changes in the working tree',
      '- Do NOT push — only commit locally',
      '- If there are no file changes, something is wrong — you must produce deliverables',
      '',
      'If the task is unclear, make reasonable assumptions and implement. Do not exit without producing code.',
      retryNote,
      '## Task',
      '',
      prompt,
    ].join('\n');
  }

  private withIntegrationTestPreamble(prompt: string, job: Job): string {
    const retryNote = job.retryCount > 0
      ? `\nThis is retry #${job.retryCount}. Previous integration test attempt failed.\n`
      : '';

    return [
      '## Integration Test Checkpoint',
      '',
      'You are running an integration test checkpoint. Your job is to verify that',
      'the implemented features actually work together end-to-end.',
      '',
      '### What to do:',
      '1. Read the project\'s acceptance tests (tests/acceptance/, e2e/, or similar)',
      '2. Install test dependencies if needed (e.g. `npx playwright install`)',
      '3. Start the application server in the background',
      '4. Run the acceptance/e2e test suite',
      '5. If no acceptance tests exist, perform manual smoke testing:',
      '   - Start the server',
      '   - Hit each API endpoint and verify responses',
      '   - For frontend: navigate to each page, verify rendering',
      '   - Test user flows: signup → login → use feature → verify result',
      '6. Report results clearly: which tests passed, which failed, and why',
      '',
      '### Output format:',
      '```',
      'INTEGRATION TEST RESULTS',
      '========================',
      'Feature: [feature name]',
      '',
      'PASSED:',
      '- [test/flow description]',
      '',
      'FAILED:',
      '- [test/flow description]: [error/reason]',
      '',
      'OVERALL: PASS / FAIL',
      '```',
      '',
      'Do NOT fix code yourself. Report failures accurately so fix jobs can be created.',
      retryNote,
      '## Test Scope',
      '',
      prompt,
    ].join('\n');
  }

  private checkDeliverables(job: Job): { passed: boolean; reason: string } {
    const workdir = typeof job.params.workdir === 'string' ? job.params.workdir : this.stateStore.projectPath;

    try {
      const gitStatus = execSync('git status --porcelain', {
        cwd: workdir,
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      const gitDiff = execSync('git diff --stat HEAD', {
        cwd: workdir,
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (gitStatus.length === 0 && gitDiff.length === 0) {
        return {
          passed: false,
          reason: 'Dev job completed but produced no file changes. Worker may have explored instead of implementing. Use tenet_retry_job with an enhanced prompt.',
        };
      }

      return { passed: true, reason: '' };
    } catch {
      // If git is not available or workdir isn't a repo, skip the check
      return { passed: true, reason: '' };
    }
  }

  private persistReadinessVerdict(job: Job, rawOutput: unknown): void {
    if (job.type !== 'eval' || job.params.eval_type !== 'readiness_validation') {
      return;
    }

    const feature = typeof job.params.feature === 'string' ? job.params.feature : undefined;
    if (!feature) {
      return;
    }

    const parsed = extractRubricJson(rawOutput);
    if (!parsed) {
      return;
    }

    if (typeof parsed.eval_parallel_safe === 'boolean') {
      this.stateStore.setConfig(
        `eval_parallel_safe:${feature}`,
        parsed.eval_parallel_safe ? 'true' : 'false',
      );
      this.stateStore.appendEvent(job.id, 'readiness_verdict_persisted', {
        feature,
        eval_parallel_safe: parsed.eval_parallel_safe,
      });
    }
  }

  /**
   * Resolve the critic stages the resume gate should wait for. `tenet_start_eval`
   * stamps `expected_eval_stages` onto every critic it dispatches (reflecting the
   * project's `.tenet/critics.json` roster — so disabling a built-in or adding a
   * custom critic shrinks/grows the set). Sibling jobs from before that stamping
   * existed fall back to the 3 built-ins.
   *
   * When a source job was evaluated multiple times (re-fired `tenet_start_eval`
   * after retries), the stamp shared by the MOST siblings is authoritative — the
   * roster at dispatch. A legitimate dispatch stamps every critic identically,
   * so a self-serving partial stamp on a single ad-hoc re-fire cannot shrink
   * the roster (a disabled built-in or a custom critic shrinks/grows the set
   * consistently across all critics of a dispatch).
   */
  private resolveExpectedEvalStages(sourceJobId: string): Set<string> {
    const siblings = this.stateStore.getEvalsForSource(sourceJobId);
    // Use the expected_eval_stages stamp shared by the MOST siblings — the
    // roster at dispatch. A legitimate dispatch stamps every critic with the
    // same roster (so a disabled built-in or a custom critic shrinks/grows the
    // set consistently); a self-serving partial stamp on a single ad-hoc
    // re-fire must not override it, or the gate would exclude a red stage and
    // unblock on a partial re-evaluation. Falls back to DEFAULT_EVAL_STAGES
    // when no stamp is shared.
    const counts = new Map<string, { stages: string[]; count: number }>();
    let unstampedCount = 0;
    for (const s of siblings) {
      const stamped = s.params.expected_eval_stages;
      if (!Array.isArray(stamped) || stamped.length === 0) {
        unstampedCount++;
        continue;
      }
      const stages = stamped.filter((st): st is string => typeof st === 'string');
      if (stages.length === 0) {
        unstampedCount++;
        continue;
      }
      const key = stages.join(',');
      const entry = counts.get(key);
      if (entry) {
        entry.count++;
      } else {
        counts.set(key, { stages, count: 1 });
      }
    }
    let best: { stages: string[]; count: number } | undefined;
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) {
        best = entry;
      }
    }
    // Adopt the stamp only when it is shared by a MAJORITY of the total
    // siblings (or all siblings are stamped). A partial stamp shared by a
    // minority of ad-hoc re-fires against unstamped legacy originals must not
    // become the roster — fall back to DEFAULT.
    if (best && (best.count > siblings.length / 2 || unstampedCount === 0)) {
      return new Set(best.stages);
    }
    return new Set(DEFAULT_EVAL_STAGES);
  }

  private checkBlockingFindingResume(completedJob: Job, rawOutput: unknown): void {
    const completedStage =
      typeof completedJob.params.eval_stage === 'string' ? completedJob.params.eval_stage : '';
    if (!completedStage) {
      return;
    }

    const sourceJobId =
      typeof completedJob.params.source_job_id === 'string' ? completedJob.params.source_job_id : undefined;
    if (!sourceJobId) {
      return;
    }

    const sourceJob = this.stateStore.getJob(sourceJobId);
    if (!sourceJob) {
      return;
    }

    const blockedParentId =
      typeof sourceJob.params.blocking_finding_for === 'string' ? sourceJob.params.blocking_finding_for : undefined;
    if (!blockedParentId) {
      return;
    }

    const parent = this.stateStore.getJob(blockedParentId);
    if (!parent || parent.status !== 'blocked_on_finding') {
      return;
    }

    const siblings = this.stateStore.getEvalsForSource(sourceJobId);

    // Round-based resume gate. `tenet_start_eval` stamps every critic in one
    // dispatch with a shared `eval_round` id. A re-fire (after a child retry)
    // gets a fresh id. Only the NEWEST round ever decides the gate — every
    // critic in a round evaluated the same source state, so requiring the
    // whole round to pass avoids mixing verdicts across code revisions (the
    // "green gate, still wrong code" failure). The gate runs whenever at least
    // one stamped round exists; unstamped siblings (ad-hoc re-fires via
    // tenet_start_job, legacy pre-stamp evals) become singleton rounds inside
    // the round gate, so a NEWER unstamped critic forces the gate to wait for
    // a fresh stamped round (fail-closed) instead of being invisible — a red
    // ad-hoc re-fire must not be ignored while the parent unblocks on an older
    // round's stale green. Only when NO sibling is stamped (all-legacy DB) do
    // we fall back to per-stage-newest so old stuck parents still recover.
    const hasStampedRound =
      siblings.length > 0 &&
      siblings.some((s) => typeof s.params.eval_round === 'string' && s.params.eval_round !== '');
    if (hasStampedRound) {
      this.checkBlockingFindingResumeByRound(siblings, blockedParentId, sourceJobId);
      return;
    }

    // Fallback: per-stage-newest (pre-round-id behavior).
    this.checkBlockingFindingResumeByStage(completedJob, siblings, sourceJobId, completedStage, rawOutput, blockedParentId);
  }

  private checkBlockingFindingResumeByRound(
    siblings: Job[],
    blockedParentId: string,
    sourceJobId: string,
  ): void {
    // Group by round id; pick the newest round by its START (min createdAt of
    // its critics) — see the selection loop below.
    // Unstamped siblings (ad-hoc re-fires via tenet_start_job, legacy pre-stamp
    // evals) become singleton rounds keyed by job id. A singleton can never
    // satisfy "every expected stage present", so a NEWER unstamped critic
    // forces the gate to wait for a fresh stamped round (fail-closed) instead
    // of being invisible — otherwise a red ad-hoc re-fire could be ignored
    // while the parent unblocks on an older round's stale green.
    const byRound = new Map<string, Job[]>();
    for (const s of siblings) {
      const stamped = typeof s.params.eval_round === 'string' && s.params.eval_round !== '';
      const roundId = stamped ? (s.params.eval_round as string) : `__unstamped__${s.id}`;
      const arr = byRound.get(roundId) ?? [];
      arr.push(s);
      byRound.set(roundId, arr);
    }
    let newestRoundId = '';
    let newestCreatedAt = -1;
    for (const [roundId, jobs] of byRound) {
      // Key on the round's START (min createdAt), not its max: a round's
      // source state is its dispatch time, and an unstamped ad-hoc critic
      // created BETWEEN a round's critics (after the round started but before
      // its last critic) is a newer evaluation that must force the gate to
      // wait — with max-based selection it would be invisible (the round's
      // max beats it).
      const minCreated = jobs.reduce((m, j) => (j.createdAt < m ? j.createdAt : m), Infinity);
      // >= (not >): on a same-ms tie, keep the later-seen round (iteration
      // order is createdAt ASC), never the stale one.
      if (minCreated >= newestCreatedAt) {
        newestCreatedAt = minCreated;
        newestRoundId = roundId;
      }
    }
    if (!newestRoundId) return;
    const currentRound = byRound.get(newestRoundId) ?? [];

    // Read this round's own expected_eval_stages stamp (shared by all its
    // critics). A STAMPED round — multi-critic or singleton — trusts its own
    // stamp: a legitimate dispatch stamps every critic with the CURRENT
    // roster, so a roster shrink between rounds (a built-in disabled) is
    // honored and a 1-critic roster is not stranded against an older round's
    // larger roster or the full DEFAULT_EVAL_STAGES. An UNSTAMPED round
    // (ad-hoc re-fire) always requires the full DEFAULT_EVAL_STAGES.
    // KNOWN LIMITATION: a FORGED stamped round (ad-hoc re-fires via
    // tenet_start_job carrying a made-up eval_round + a self-serving partial
    // stamp) is trusted outright — defense-in-depth, since a determined caller
    // could instead create a full passing round and unblock legitimately.
    const isStampedRound = currentRound.some(
      (s) => typeof s.params.eval_round === 'string' && s.params.eval_round !== '',
    );
    const stamp = isStampedRound
      ? currentRound.find((s) => Array.isArray(s.params.expected_eval_stages))?.params.expected_eval_stages
      : undefined;
    const filteredStages = Array.isArray(stamp) && stamp.length > 0
      ? new Set(stamp.filter((st): st is string => typeof st === 'string'))
      : undefined;
    // A stamp that filters to an empty set (malformed non-string entries) must
    // NOT produce an empty expectedStages — both the stage-presence loop and
    // the completion loop would pass trivially and the gate would fail open.
    const expectedStages = filteredStages && filteredStages.size > 0
      ? filteredStages
      : new Set(DEFAULT_EVAL_STAGES);

    const presentStages = new Set(
      currentRound
        .map((s) => (typeof s.params.eval_stage === 'string' ? s.params.eval_stage : ''))
        .filter((st) => expectedStages.has(st)),
    );
    for (const expected of expectedStages) {
      if (!presentStages.has(expected)) return;
    }

    for (const s of currentRound) {
      const stage = typeof s.params.eval_stage === 'string' ? s.params.eval_stage : '';
      if (!expectedStages.has(stage)) continue;
      if (s.status !== 'completed') return;
      const siblingOutput = this.stateStore.getJobOutput(s.id);
      const rawSibling = this.extractAdapterRawOutput(siblingOutput);
      const parsed = extractRubricJson(rawSibling);
      if (!parsed || parsed.passed !== true) return;
    }

    // Newest round fully passed — let the report-only parent run again.
    this.stateStore.updateJob(blockedParentId, {
      status: 'pending',
      startedAt: undefined,
      completedAt: undefined,
      lastHeartbeat: undefined,
      error: undefined,
    });
    this.stateStore.appendEvent(blockedParentId, 'blocking_finding_resolved', {
      child_job_id: sourceJobId,
      eval_round: newestRoundId,
    });
  }

  private checkBlockingFindingResumeByStage(
    completedJob: Job,
    siblings: Job[],
    sourceJobId: string,
    completedStage: string,
    rawOutput: unknown,
    blockedParentId: string,
  ): void {
    // Parse this critic's output to confirm it passed
    const thisCritic = extractRubricJson(rawOutput);
    if (!thisCritic || thisCritic.passed !== true) {
      return;
    }

    const expectedStages = this.resolveExpectedEvalStages(sourceJobId);
    if (!expectedStages.has(completedStage)) {
      return;
    }

    const evalSiblings = siblings.filter((s) => {
      const stage = typeof s.params.eval_stage === 'string' ? s.params.eval_stage : '';
      return expectedStages.has(stage);
    });

    // A source job may have been evaluated multiple times (re-fired
    // `tenet_start_eval` after retries). Older rounds' critics — including ones
    // that failed — are history: only the newest critic per stage decides the
    // gate, otherwise a stale failure from an earlier round blocks the parent
    // forever even after the current round is fully green.
    const latestByStage = new Map<string, Job>();
    for (const s of evalSiblings) {
      const stage = typeof s.params.eval_stage === 'string' ? s.params.eval_stage : '';
      const existing = latestByStage.get(stage);
      // >= (not >): equal createdAt (same-ms dispatch in tests) keeps the
      // later-seen job — never let the stale one win a tie.
      if (!existing || s.createdAt >= existing.createdAt) {
        latestByStage.set(stage, s);
      }
    }
    const currentRound = [...latestByStage.values()];

    const presentStages = new Set(currentRound.map((s) => s.params.eval_stage as string));
    for (const expected of expectedStages) {
      if (!presentStages.has(expected)) {
        return;
      }
    }

    // A single ad-hoc re-fire (tenet_start_job) created long after the other
    // stages' critics is a partial re-evaluation, not a full round — it must
    // not mask an older red critic for its stage. A full re-evaluation
    // dispatches all critics synchronously, so require the newest critic per
    // stage to be created within a window of the completing critic.
    // KNOWN LIMITATION: a re-fire created >1s after the round dispatch but
    // BEFORE the round completes strands the green round (every subsequent
    // completion fails the window) — fail-closed, recoverable by a fresh full
    // round, but requires manual intervention.
    const completingCreatedAt = completedJob.createdAt;
    for (const s of currentRound) {
      if (Math.abs(s.createdAt - completingCreatedAt) > COHORT_WINDOW_MS) {
        return;
      }
    }

    for (const s of currentRound) {
      if (s.status !== 'completed') {
        return;
      }
      const siblingOutput = this.stateStore.getJobOutput(s.id);
      const rawSibling = this.extractAdapterRawOutput(siblingOutput);
      const parsed = extractRubricJson(rawSibling);
      if (!parsed || parsed.passed !== true) {
        return;
      }
    }

    this.stateStore.updateJob(blockedParentId, {
      status: 'pending',
      startedAt: undefined,
      completedAt: undefined,
      lastHeartbeat: undefined,
      error: undefined,
    });
    this.stateStore.appendEvent(blockedParentId, 'blocking_finding_resolved', {
      child_job_id: sourceJobId,
    });
  }

  private extractAdapterRawOutput(output: unknown): unknown {
    if (output && typeof output === 'object' && 'output' in (output as Record<string, unknown>)) {
      return (output as { output: unknown }).output;
    }
    return output;
  }

  private dispatchChainedChildren(parentJobId: string): void {
    const children = this.stateStore.getChildJobs(parentJobId);
    for (const child of children) {
      if (child.status !== 'pending') {
        continue;
      }
      if (child.params.auto_dispatch_on_parent_complete !== true) {
        continue;
      }
      try {
        this.dispatchJob(child.id);
      } catch {
        // If dispatch fails (e.g. status already changed), skip silently
      }
    }
  }

  private progressLine(status: Job['status']): string {
    switch (status) {
      case 'pending':
        return 'job pending';
      case 'running':
        return 'job running';
      case 'completed':
        return 'job completed';
      case 'failed':
        return 'job failed';
      case 'cancelled':
        return 'job cancelled';
      case 'blocked':
        return 'job blocked';
      case 'blocked_on_finding':
        return 'job blocked — waiting for blocking finding follow-up';
      default:
        return 'job status unknown';
    }
  }
}
