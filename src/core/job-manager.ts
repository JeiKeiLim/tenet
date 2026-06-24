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

type JobManagerConfig = {
  maxParallelAgents?: number;
  heartbeatTimeoutMs?: number;
  defaultJobTimeoutMs?: number;
  serverId?: string;
};

const TERMINAL_STATUSES = new Set<Job['status']>(['completed', 'failed', 'cancelled']);

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const extractRubricJson = (rawOutput: unknown): Record<string, unknown> | null => {
  if (rawOutput && typeof rawOutput === 'object') {
    return rawOutput as Record<string, unknown>;
  }

  if (typeof rawOutput !== 'string') {
    return null;
  }

  const stripped = rawOutput.trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1].trim(), stripped] : [stripped];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate
    }

    // Fallback: locate the outermost JSON object substring
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const sliced = candidate.slice(start, end + 1);
        const parsed = JSON.parse(sliced);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Give up
      }
    }
  }

  return null;
};

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

    if (job.status !== 'pending') {
      throw new Error(`job ${jobId} is ${job.status}, expected pending`);
    }

    const now = Date.now();
    this.stateStore.updateJob(jobId, {
      status: 'running',
      startedAt: now,
      lastHeartbeat: now,
      agentName: this.resolveAgentName(job.type),
    });
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

    if (!hasRetryBudgetRemaining(job.retryCount, job.maxRetries)) {
      throw new Error(
        `job ${jobId} has exhausted retries (${job.retryCount}/${formatMaxRetries(job.maxRetries)})`,
      );
    }

    const params = { ...job.params };
    if (enhancedPrompt) {
      params.prompt = enhancedPrompt;
    }

    this.stateStore.updateJob(jobId, {
      status: 'pending',
      params,
      startedAt: undefined,
      completedAt: undefined,
      lastHeartbeat: undefined,
      error: undefined,
      retryCount: job.retryCount + 1,
    });
    this.stateStore.appendEvent(jobId, 'job_retried', {
      retry_count: job.retryCount + 1,
      has_enhanced_prompt: !!enhancedPrompt,
    });

    const updated = this.stateStore.getJob(jobId);
    if (!updated) {
      throw new Error(`failed to load retried job: ${jobId}`);
    }

    return updated;
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
    const context = typeof job.params.context === 'string' ? job.params.context : undefined;

    const maxTurnsRaw = job.params.maxTurns;
    const maxTurns =
      typeof maxTurnsRaw === 'number' && Number.isFinite(maxTurnsRaw)
        ? Math.max(1, Math.floor(maxTurnsRaw))
        : undefined;

    const workdir = typeof job.params.workdir === 'string' ? job.params.workdir : this.stateStore.projectPath;

    const configuredTimeout = parseTimeoutMinutes(this.stateStore.getConfig('timeout_minutes'));
    const timeoutMs = configuredTimeout ? configuredTimeout * 60 * 1000 : undefined;

    // Browser/visual e2e jobs need access to Playwright MCP tools for exploratory testing.
    // CLI/API/library jobs with this legacy job type simply won't use them.
    const allowedTools = job.type === 'playwright_eval'
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
      '- Write or modify source code files that implement the described feature',
      '- Ensure the code compiles/passes type-checking',
      '- Run existing tests to verify no regressions',
      '- If acceptance tests exist (tests/acceptance/ or similar), run them and fix any failures related to your work',
      '- Write BEHAVIORAL tests that verify observable outcomes (e.g., "login returns session cookie and redirects to dashboard")',
      '- Do NOT write tests that only check absence of errors or internal state — a separate test critic will reject them',
      '- Every new endpoint, page, or feature MUST have at least one test that verifies it works correctly',
      '- Do NOT just explore, research, or describe what could be done — actually implement it',
      projectDoctrineAuthorized
        ? '- This job is explicitly authorized to edit `.tenet/project/**` project doctrine.'
        : '- Do NOT edit `.tenet/project/**`; write proposed doctrine updates to the run-local journal or final report instead.',
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
   */
  private resolveExpectedEvalStages(sourceJobId: string): Set<string> {
    const siblings = this.stateStore.getEvalsForSource(sourceJobId);
    for (const s of siblings) {
      const stamped = s.params.expected_eval_stages;
      if (Array.isArray(stamped) && stamped.length > 0) {
        return new Set(stamped.filter((stage): stage is string => typeof stage === 'string'));
      }
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

    // Parse this critic's output to confirm it passed
    const thisCritic = extractRubricJson(rawOutput);
    if (!thisCritic || thisCritic.passed !== true) {
      return;
    }

    const expectedStages = this.resolveExpectedEvalStages(sourceJobId);
    if (!expectedStages.has(completedStage)) {
      return;
    }

    const siblings = this.stateStore.getEvalsForSource(sourceJobId);
    const evalSiblings = siblings.filter((s) => {
      const stage = typeof s.params.eval_stage === 'string' ? s.params.eval_stage : '';
      return expectedStages.has(stage);
    });

    // Wait until every expected stage has a sibling before deciding — a disabled
    // built-in shrinks this set, a custom critic grows it.
    const presentStages = new Set(evalSiblings.map((s) => s.params.eval_stage as string));
    for (const expected of expectedStages) {
      if (!presentStages.has(expected)) {
        return;
      }
    }

    for (const s of evalSiblings) {
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

    // All expected critics passed — let the report-only parent run again with fresh context.
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
