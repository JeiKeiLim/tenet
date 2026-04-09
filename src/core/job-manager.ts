import { execSync } from 'node:child_process';
import type { ContinuationState, Job, JobResult, JobType, JobWaitResponse } from '../types/index.js';
import { AdapterRegistry } from '../adapters/index.js';
import type { AgentAdapter, AgentInvocation } from '../adapters/base.js';
import { StateStore } from './state-store.js';

type JobManagerConfig = {
  maxParallelAgents?: number;
  heartbeatTimeoutMs?: number;
  defaultJobTimeoutMs?: number;
};

const TERMINAL_STATUSES = new Set<Job['status']>(['completed', 'failed', 'cancelled']);

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

  constructor(stateStore: StateStore, adapterRegistry: AdapterRegistry, config?: JobManagerConfig) {
    this.stateStore = stateStore;
    this.adapterRegistry = adapterRegistry;
    this.maxParallelAgents = config?.maxParallelAgents ?? 4;
    this.heartbeatTimeoutMs = config?.heartbeatTimeoutMs ?? 300_000;
    this.defaultJobTimeoutMs = config?.defaultJobTimeoutMs ?? 30_000;
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
    this.stateStore.appendEvent(jobId, 'job_started', { type: job.type });

    setTimeout(() => {
      void this.executeJob(jobId);
    }, 0);

    const updated = this.stateStore.getJob(jobId);
    if (!updated) {
      throw new Error(`failed to load dispatched job: ${jobId}`);
    }

    return updated;
  }

  private getMaxRetries(): number {
    const configured = this.stateStore.getConfig('max_retries');
    if (configured) {
      const parsed = Number.parseInt(configured, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    return 3;
  }

  startJob(type: JobType, params: Record<string, unknown>): Job {
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
    this.stateStore.appendEvent(job.id, 'job_started', { type });

    setTimeout(() => {
      void this.executeJob(job.id);
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

    let currentCursor = cursor ?? '0';
    const events = this.stateStore
      .getEventsSince(currentCursor)
      .filter((event) => event.jobId === jobId);
    if (events.length > 0) {
      currentCursor = events[events.length - 1].id;
    }

    const jobName = typeof job.params.name === 'string' ? job.params.name : undefined;
    const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
    const recentEvents = events.slice(-5).map((e) => e.event);

    return {
      status: job.status,
      progress_line: TERMINAL_STATUSES.has(job.status)
        ? this.progressLine(job.status)
        : `${this.progressLine(job.status)} (${Math.round(elapsed / 1000)}s elapsed)`,
      cursor: currentCursor,
      is_terminal: TERMINAL_STATUSES.has(job.status),
      elapsed_ms: elapsed,
      job_name: jobName,
      recent_events: recentEvents,
    };
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

      const events = this.stateStore
        .getEventsSince(currentCursor)
        .filter((event) => event.jobId === jobId);
      if (events.length > 0) {
        currentCursor = events[events.length - 1].id;
      }

      const jobName = typeof job.params.name === 'string' ? job.params.name : undefined;
      const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
      const recentEvents = events.slice(-5).map((e) => e.event);

      if (TERMINAL_STATUSES.has(job.status)) {
        return {
          status: job.status,
          progress_line: this.progressLine(job.status),
          cursor: currentCursor,
          is_terminal: true,
          elapsed_ms: elapsed,
          job_name: jobName,
          recent_events: recentEvents,
        };
      }

      if (Date.now() - startedAt >= timeout) {
        return {
          status: job.status,
          progress_line: `${this.progressLine(job.status)} (${Math.round(elapsed / 1000)}s elapsed)`,
          cursor: currentCursor,
          is_terminal: false,
          elapsed_ms: elapsed,
          job_name: jobName,
          recent_events: recentEvents,
        };
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

    if (job.retryCount >= job.maxRetries) {
      throw new Error(`job ${jobId} has exhausted retries (${job.retryCount}/${job.maxRetries})`);
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
    const totalCount = this.stateStore.getTotalCount();
    const completedCount = this.stateStore.getCompletedCount();

    return {
      all_done: totalCount > 0 && completedCount === totalCount,
      all_blocked: !nextJob && blockedJobs.length > 0,
      next_job: nextJob ?? undefined,
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

  private resolveAgentName(type: JobType): string {
    const typeOverride = this.stateStore.getConfig(`agent_override_${type}`);
    if (typeOverride) {
      return typeOverride;
    }

    const defaultAgent = this.stateStore.getConfig('default_agent');
    return defaultAgent ?? 'default';
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.stateStore.getJob(jobId);
    if (!job || job.status !== 'running') {
      return;
    }

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

        const stubOutput = {
          message: `No agent adapter available to execute this job. Configure one with tenet_set_agent.`,
          tried_agent: job.agentName ?? 'default',
          adapters: allNames,
          available_adapters: availableNames,
          hint: availableNames.length === 0
            ? 'No CLI agents found in PATH. Ensure claude, opencode, or codex CLI is installed and accessible.'
            : `Available: ${availableNames.join(', ')}. Use tenet_set_agent to assign.`,
          type: job.type,
          params: job.params,
        };

        const finishedAt = Date.now();
        this.stateStore.setJobOutput(jobId, stubOutput);
        this.stateStore.updateJob(jobId, {
          status: 'failed',
          completedAt: finishedAt,
          lastHeartbeat: finishedAt,
          error: 'no agent adapter available',
        });
        this.stateStore.appendEvent(jobId, 'job_failed', { error: 'no agent adapter available', output: stubOutput });
        return;
      }

      const invocation = this.toInvocation(job);
      const response = await adapter.invoke(invocation);
      const finishedAt = Date.now();

      this.stateStore.setJobOutput(jobId, {
        adapter: adapter.name,
        output: response.output,
        duration_ms: response.durationMs,
      });

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
    if (agentName && agentName !== 'default') {
      const explicit = this.adapterRegistry.get(agentName);
      if (explicit && (await explicit.isAvailable())) {
        return explicit;
      }
    }

    try {
      return await this.adapterRegistry.getDefault();
    } catch {
      return null;
    }
  }

  private toInvocation(job: Job): AgentInvocation {
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

    return {
      prompt,
      context,
      maxTurns,
      workdir,
    };
  }

  private withDevPreamble(prompt: string, job: Job): string {
    const feature = typeof job.params.feature === 'string' ? job.params.feature : '';
    const jobName = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
    const retryNote = job.retryCount > 0
      ? [
          '',
          `This is retry #${job.retryCount}. The previous attempt failed.`,
          'BEFORE starting work, check .tenet/journal/ for failure logs matching this job.',
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
      '- Do NOT just explore, research, or describe what could be done — actually implement it',
      '',
      '## Smoke Check (mandatory before exiting)',
      '- If this is a server/API feature: start the server, verify your endpoints respond (non-5xx)',
      '- If this is a frontend feature: start the dev server, verify pages render without errors',
      '- If smoke check fails, fix the issue before exiting',
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
      default:
        return 'job status unknown';
    }
  }
}
