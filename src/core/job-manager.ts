import crypto from 'node:crypto';
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
    this.serverId = crypto.randomUUID();

    // Reset any jobs left "running" by a previous server instance
    const resetCount = this.stateStore.resetOrphanedJobs(this.serverId);
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
    const configured = this.stateStore.getConfig('max_retries');
    if (configured) {
      const parsed = Number.parseInt(configured, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    return 3;
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

        this.persistReadinessVerdict(job, response.output);
        this.dispatchChainedChildren(jobId);
        this.checkRemediationResume(job, response.output);
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

    const configuredTimeout = this.stateStore.getConfig('timeout_minutes');
    const timeoutMs = configuredTimeout
      ? Number.parseInt(configuredTimeout, 10) * 60 * 1000
      : undefined;

    // Playwright eval jobs need access to Playwright MCP tools for exploratory testing
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
      '- Write BEHAVIORAL tests that verify observable outcomes (e.g., "login returns session cookie and redirects to dashboard")',
      '- Do NOT write tests that only check absence of errors or internal state — a separate test critic will reject them',
      '- Every new endpoint, page, or feature MUST have at least one test that verifies it works correctly',
      '- Do NOT just explore, research, or describe what could be done — actually implement it',
      '',
      '## Smoke Check (mandatory before exiting)',
      '- If this is a server/API feature: start the server, verify your endpoints respond (non-5xx)',
      '- If this is a frontend feature: start the dev server, verify pages render without errors',
      '- If smoke check fails, fix the issue before exiting',
      '',
      '## Git Commit (mandatory before exiting, if .git/ exists)',
      '- Stage all files you changed (use `git add` with specific paths, NOT `git add -A`)',
      '- Commit with message: `tenet({job-name}): {short description of what was done}`',
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

  private checkRemediationResume(completedJob: Job, rawOutput: unknown): void {
    const evalStages = new Set(['code_critic', 'test_critic', 'playwright_eval']);
    if (!evalStages.has(typeof completedJob.params.eval_stage === 'string' ? completedJob.params.eval_stage : '')) {
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

    const remediationFor =
      typeof sourceJob.params.remediation_for === 'string' ? sourceJob.params.remediation_for : undefined;
    if (!remediationFor) {
      return;
    }

    const parent = this.stateStore.getJob(remediationFor);
    if (!parent || parent.status !== 'blocked_remediation_required') {
      return;
    }

    // Parse this critic's output to confirm it passed
    const thisCritic = extractRubricJson(rawOutput);
    if (!thisCritic || thisCritic.passed !== true) {
      return;
    }

    const siblings = this.stateStore.getEvalsForSource(sourceJobId);
    const evalSiblings = siblings.filter((s) => {
      const stage = typeof s.params.eval_stage === 'string' ? s.params.eval_stage : '';
      return evalStages.has(stage);
    });

    // Need all three critic stages present and all completed with passed:true
    const stages = new Set(evalSiblings.map((s) => s.params.eval_stage as string));
    if (stages.size < 3) {
      return;
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

    // All three critics passed — auto-resume the remediation parent
    this.stateStore.updateJob(remediationFor, {
      status: 'pending',
      startedAt: undefined,
      completedAt: undefined,
      lastHeartbeat: undefined,
      error: undefined,
    });
    this.stateStore.appendEvent(remediationFor, 'remediation_resumed', {
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
      case 'blocked_remediation_required':
        return 'job blocked — waiting for child remediation';
      default:
        return 'job status unknown';
    }
  }
}
