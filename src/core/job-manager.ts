import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ContinuationState, Job, JobResult, JobType, JobWaitResponse, PendingReason } from '../types/index.js';
import { AdapterRegistry, parseAdapterExtraArgs, ADAPTER_NAME_TO_KEY } from '../adapters/index.js';
import type { AgentAdapter, AgentInvocation } from '../adapters/base.js';
import {
  buildDispatchConfigSnapshot,
  createLiveStateConfigReader,
  formatMaxRetries,
  hasRetryBudgetRemaining,
  nonEmptyString,
  resolveGatePair,
  stateConfigFilePath,
  type DispatchConfigSnapshot,
  type GateKey,
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

export type JobManagerConfig = {
  maxParallelAgents?: number;
  heartbeatTimeoutMs?: number;
  defaultJobTimeoutMs?: number;
  serverId?: string;
  /**
   * Live raw `.tenet/.state/config.json` provider — called once per dispatch to
   * build a DispatchConfigSnapshot (agent/model pairs, default/override agents,
   * adapter args, retry/timeout scalars). Entry points pass the keep-last-good
   * reader (jobManagerConfigForLiveReads), so config edits apply from the next
   * dispatched job with no restart; tests pin a constant object. Defaults to a
   * no-config provider.
   */
  readStateConfig?: () => Record<string, unknown>;
};

/**
 * The JobManager config both server entry points (src/mcp/index.ts and
 * src/cli/serve.ts) build: the server id plus a live, keep-last-good
 * config.json reader. One factory so the two entry points cannot drift — an
 * entry point that stops consuming it is a loud refactor. Unit-tested
 * directly — no test can import either entry point (both boot the MCP
 * server at module scope).
 */
export const jobManagerConfigForLiveReads = (projectPath: string, serverId: string): JobManagerConfig => ({
  serverId,
  readStateConfig: createLiveStateConfigReader(stateConfigFilePath(projectPath)),
});

/**
 * Frozen-config variant for tests and embedders that pin one raw config
 * object: the provider returns the same parsed object on every dispatch.
 */
export const jobManagerConfigFromStateConfig = (
  rawStateConfig: Record<string, unknown> | null | undefined,
  serverId: string,
): JobManagerConfig => ({ serverId, readStateConfig: () => rawStateConfig ?? {} });

/** Which agent+model will judge a validation gate, and which tier resolved it. */
export type GateDispatchInfo = {
  /** Executing agent — tiers 1-3 force this agent at every dispatch point. */
  agent: string;
  /** Pinned model (undefined = the adapter's CLI default). */
  model?: string;
  /**
   * The tier that resolved: the gate's own pair, the sibling gate's pair, the
   * adviser pair, or today's default eval path.
   */
  tier: 'gate' | 'sibling' | 'adviser' | 'default';
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
  private readonly readStateConfig: () => Record<string, unknown>;

  constructor(stateStore: StateStore, adapterRegistry: AdapterRegistry, config?: JobManagerConfig) {
    this.stateStore = stateStore;
    this.adapterRegistry = adapterRegistry;
    this.maxParallelAgents = config?.maxParallelAgents ?? 4;
    this.heartbeatTimeoutMs = config?.heartbeatTimeoutMs ?? 30 * 60 * 1000;
    this.defaultJobTimeoutMs = config?.defaultJobTimeoutMs ?? 30_000;
    this.serverId = config?.serverId ?? crypto.randomUUID();
    this.readStateConfig = config?.readStateConfig ?? (() => ({}));

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

  /**
   * One per-dispatch config snapshot: read the live raw config.json once and
   * parse every view from that single read. Every dispatch entry point
   * (startJob, dispatchJob, executeJob, the validator tools' reports, the
   * adviser gate) resolves agent + model + args + scalars through exactly one
   * snapshot, so a config edit can never split what runs from what was
   * reported. Pickup semantics: pending jobs pick up config at dispatch;
   * running jobs never do (argv is frozen at spawn).
   */
  takeConfigSnapshot(): DispatchConfigSnapshot {
    return buildDispatchConfigSnapshot(this.readStateConfig());
  }

  dispatchJob(jobId: string, configSnapshot?: DispatchConfigSnapshot): Job {
    const job = this.stateStore.getJob(jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }

    if (job.status !== 'pending') {
      throw new Error(`job ${jobId} is ${job.status}, expected pending`);
    }

    const now = Date.now();
    // One snapshot per dispatch: the stamp below, the execution resolution, and
    // the adapter args/model all come from the same config read.
    const snapshot = configSnapshot ?? this.takeConfigSnapshot();
    // Adviser jobs are created with an explicit adviser agent; re-resolving here would
    // overwrite it with default_agent and silently run the adviser on a different CLI
    // than its --model was chosen for. Validator gates share job type 'eval' with
    // critics, so their chain must be re-checked here too — without this, a retry
    // (retryJob -> dispatchJob) would overwrite the stored gate agent with
    // resolveAgentName('eval') and silently drop the gate pair. Ordinary jobs keep
    // resolve-at-dispatch. The stamp is display state; executeJob re-resolves from
    // the same snapshot authoritatively.
    const dispatchAgentName =
      job.type === 'adviser'
        ? job.agentName ?? snapshot.pairs.adviser?.agent ?? this.resolveAgentName(job.type, snapshot)
        : this.effectiveGateAgent(job.type, job.params, snapshot) ?? this.resolveAgentName(job.type, snapshot);
    // Atomic pending -> running: only one process can win. If another process
    // dispatched it between our read and this update, return the current job
    // instead of double-executing.
    if (!this.stateStore.markJobRunning(jobId, now, dispatchAgentName)) {
      const current = this.stateStore.getJob(jobId);
      if (!current) {
        throw new Error(`failed to load dispatched job: ${jobId}`);
      }
      return current;
    }
    this.stateStore.setJobServerId(jobId, this.serverId);
    this.stateStore.appendEvent(jobId, 'job_started', { type: job.type });

    setTimeout(() => {
      this.executeJob(jobId, snapshot).catch(() => {
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

  createPendingJob(type: JobType, params: Record<string, unknown>, parentJobId?: string): Job {
    if (!params.name || typeof params.name !== 'string') {
      params = { ...params, name: `${type}-${Date.now().toString(36)}` };
    }

    const snapshot = this.takeConfigSnapshot();
    const job = this.stateStore.createJob({
      type,
      status: 'pending',
      params,
      // Validator gate jobs (the tools' deterministic preflight creations) stamp
      // the effective gate agent for display consistency even though they never
      // dispatch; every other type keeps resolveAgentName's behavior.
      agentName: this.effectiveGateAgent(type, params, snapshot) ?? this.resolveAgentName(type, snapshot),
      retryCount: 0,
      maxRetries: snapshot.maxRetries,
      parentJobId,
    });

    return job;
  }

  startJob(
    type: JobType,
    params: Record<string, unknown>,
    opts?: { agentName?: string; configSnapshot?: DispatchConfigSnapshot },
  ): Job {
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

    // One snapshot per dispatch: the creation stamps (agent + max_retries) and
    // the execution resolution below all come from the same config read.
    const snapshot = opts?.configSnapshot ?? this.takeConfigSnapshot();
    const job = this.stateStore.createJob({
      type,
      status: 'pending',
      params,
      // The explicit agent is only used by adviser dispatch; validator gates
      // resolve their pair from params.eval_type (see effectiveGateAgent); every
      // other caller (ad-hoc jobs, critics, retries) keeps resolveAgentName.
      agentName:
        opts?.agentName ?? this.effectiveGateAgent(type, params, snapshot) ?? this.resolveAgentName(type, snapshot),
      retryCount: 0,
      maxRetries: snapshot.maxRetries,
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
      this.executeJob(job.id, snapshot).catch(() => {
        // See setTimeout in dispatchJob for rationale
      });
    }, 0);

    const created = this.stateStore.getJob(job.id);
    if (!created) {
      throw new Error(`failed to load created job: ${job.id}`);
    }

    return created;
  }

  /** True iff both adviser keys are configured in the live config. */
  isAdviserConfigured(configSnapshot?: DispatchConfigSnapshot): boolean {
    return (configSnapshot ?? this.takeConfigSnapshot()).pairs.adviser !== undefined;
  }

  /**
   * Resolve which agent+model will judge a validation gate, and which tier
   * resolved it: the gate's own pair, the sibling gate's pair, the adviser
   * pair, or today's default eval path (agent_override_eval ?? default_agent,
   * with default_agent_model pinned when that path lands on the default agent).
   * The validator tools report this in their dispatch responses — nothing else
   * records the judging model anywhere. Pass the SAME snapshot the dispatch
   * uses (the tools take one per dispatch and thread it through startJob) so
   * validator_agent/validator_model always match what really runs.
   *
   * Returns undefined only when no agent resolves at all (the dispatch itself
   * would fail with the no-agent stub).
   */
  getGateDispatchInfo(evalType: unknown, configSnapshot?: DispatchConfigSnapshot): GateDispatchInfo | undefined {
    const gate = this.gateKeyForEvalType(evalType);
    if (gate === undefined) {
      return undefined;
    }

    const snapshot = configSnapshot ?? this.takeConfigSnapshot();
    const own = snapshot.pairs.gateValidators?.[gate];
    if (own) {
      return { agent: own.agent, model: own.model, tier: 'gate' };
    }
    // Mirrors resolveGatePair tier-for-tier; keep the two walks in sync.
    const sibling = snapshot.pairs.gateValidators?.[gate === 'clarity' ? 'readiness' : 'clarity'];
    if (sibling) {
      return { agent: sibling.agent, model: sibling.model, tier: 'sibling' };
    }
    if (snapshot.pairs.adviser) {
      return { agent: snapshot.pairs.adviser.agent, model: snapshot.pairs.adviser.model, tier: 'adviser' };
    }

    const agent = this.resolveAgentName('eval', snapshot);
    if (!agent) {
      return undefined;
    }
    const model =
      snapshot.pairs.defaultAgentModel && agent === snapshot.defaultAgent
        ? snapshot.pairs.defaultAgentModel
        : undefined;
    return { agent, model, tier: 'default' };
  }

  /**
   * Dispatch an adviser escalation job on the explicitly configured adviser agent
   * (never resolved from default_agent / agent_override_adviser). The tool layer
   * checks isAdviserConfigured() first; the throw here is a fail-closed guard.
   * Pass the same snapshot the tool's isAdviserConfigured check used so the
   * gate check and the dispatch cannot straddle a config edit.
   */
  startAdviserJob(params: Record<string, unknown>, configSnapshot?: DispatchConfigSnapshot): Job {
    const snapshot = configSnapshot ?? this.takeConfigSnapshot();
    if (!snapshot.pairs.adviser) {
      throw new Error('adviser is not configured (both adviser_agent and adviser_model must be set)');
    }

    const namedParams = typeof params.name === 'string' && params.name.length > 0
      ? params
      : { ...params, name: `adviser-${Date.now().toString(36)}` };

    return this.startJob('adviser', namedParams, { agentName: snapshot.pairs.adviser.agent, configSnapshot: snapshot });
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

    this.assertCriticRetryLegal(job);

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

    const newRetryCount = job.retryCount + 1;
    this.stateStore.appendEvent(jobId, 'job_retried', {
      retry_count: newRetryCount,
      has_enhanced_prompt: !!enhancedPrompt,
    });

    // Retry is an explicit "run it again now" action: dispatch immediately rather
    // than leaving the job pending for a poller that doesn't exist. Without this, a
    // retried job (and everything chained behind it) wedges at pending/retry_reset
    // forever — there is no background dispatch loop, and the chain event that first
    // started the job already fired. resetJobForRetry's atomic guard means the job
    // is pending here, so dispatchJob can claim it.
    return this.dispatchJob(jobId);
  }

  /**
   * Safeguard on in-place critic retries (tenet_retry_job). A retry keeps the
   * job id + params, so the critic's eval_round survives and a patched round
   * could green without re-running its siblings. Retrying is therefore legal
   * only for infra-failure retries — the critic's last run produced NO
   * verdict — and only while nothing has changed the code it evaluated:
   *
   * 1. No valid verdict exists. A parsed verdict — red OR green — forbids the
   *    re-roll: red's only path forward is the fix loop (retry the dev source,
   *    fresh eval round), green has nothing to re-run.
   * 2. No code-writing job completed since the round's dispatch. Any
   *    dev/integration_test completion in (roundDispatch, now] means the round
   *    would be greened against code that no longer exists — start a fresh
   *    round instead. Eval-type completions (the round's own siblings) never
   *    count, or the legal case could never fire.
   *
   * Fail-closed: a critic whose eval_round can't be resolved (legacy/unstamped
   * rows) is refused — never guess. Non-critic jobs are untouched.
   */
  private assertCriticRetryLegal(job: Job): void {
    const stage = typeof job.params.eval_stage === 'string' ? job.params.eval_stage : '';
    const sourceJobId = typeof job.params.source_job_id === 'string' ? job.params.source_job_id : '';
    if (!stage || !sourceJobId) {
      return; // not a critic dispatched by tenet_start_eval
    }

    const rawOutput = this.extractAdapterRawOutput(this.stateStore.getJobOutput(job.id));
    const parsed = extractRubricJson(rawOutput);
    // `passed` must be a boolean: extractRubricJson's object branch returns any
    // object without validating, and a structured output carrying no `passed` is
    // "no verdict" by the round gate's own standard — the three-way classifier's
    // retry-as-is remediation still applies to it.
    if (parsed && typeof parsed.passed === 'boolean') {
      throw new Error(
        `critic job ${job.id} (stage ${stage}) already produced a verdict (passed: ${parsed.passed}) — ` +
          `retrying in place would re-roll the round gate. ` +
          (parsed.passed
            ? 'A green verdict has nothing to re-run.'
            : 'For a red verdict, fix the source (retry the dev job), then start a fresh eval round via tenet_start_eval.'),
      );
    }

    const roundId = typeof job.params.eval_round === 'string' ? job.params.eval_round : '';
    if (!roundId) {
      throw new Error(
        `critic job ${job.id} (stage ${stage}) has no eval_round stamp (legacy or ad-hoc row) — ` +
          `its round can't be resolved, so patching it in place can't be proven safe. ` +
          `Start a fresh eval round via tenet_start_eval.`,
      );
    }

    // Same round-grouping the resume gate uses: dispatch time = the round's
    // start (min createdAt of its critics).
    const siblings = this.stateStore.getEvalsForSource(sourceJobId);
    const roundDispatch = siblings
      .filter((s) => s.params.eval_round === roundId)
      .reduce((m, s) => (s.createdAt < m ? s.createdAt : m), Infinity);
    if (!Number.isFinite(roundDispatch)) {
      throw new Error(
        `critic job ${job.id} (stage ${stage}) declares eval_round ${roundId} but no eval job for source ` +
          `${sourceJobId} carries it — the round can't be resolved. Start a fresh eval round via tenet_start_eval.`,
      );
    }

    const codeChanges = this.stateStore.getCompletedJobsByTypeSince(
      ['dev', 'integration_test'],
      roundDispatch,
    );
    if (codeChanges.length > 0) {
      const offender = codeChanges[codeChanges.length - 1]; // newest completion
      throw new Error(
        `critic job ${job.id} (stage ${stage}) belongs to eval round ${roundId} dispatched at ` +
          `${new Date(roundDispatch).toISOString()}, but ${offender.type} job ${offender.id} completed after it — ` +
          `the code this round evaluated has changed. Start a fresh eval round via tenet_start_eval.`,
      );
    }
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

  /**
   * The agent for a non-gate job, from the dispatch snapshot: an explicit
   * agent_override_<type> (a phantom knob with no live setter — kept for
   * hand-edited configs) or default_agent. Undefined fails closed at dispatch.
   */
  private resolveAgentName(type: JobType, snapshot: DispatchConfigSnapshot): string | undefined {
    return nonEmptyString(snapshot.raw[`agent_override_${type}`]) ?? snapshot.defaultAgent;
  }

  /** The eval_type values that mark a job as one of the two interview validation gates. */
  private static readonly GATE_EVAL_TYPES: ReadonlySet<string> = new Set([
    'clarity_validation',
    'readiness_validation',
  ]);

  /**
   * Map a validator eval_type to its gate key. The test critic shares job type
   * 'eval' but carries eval_stage (never eval_type), so keying on eval_type
   * isolates the gates from critics, interaction_e2e jobs, and ad-hoc evals.
   */
  private gateKeyForEvalType(evalType: unknown): GateKey | undefined {
    if (typeof evalType !== 'string' || !JobManager.GATE_EVAL_TYPES.has(evalType)) {
      return undefined;
    }
    return evalType === 'clarity_validation' ? 'clarity' : 'readiness';
  }

  /**
   * The effective gate pair for a job (own pair -> sibling pair -> adviser
   * pair), or undefined when the job is not a gate job or no tier resolves.
   */
  private effectiveGatePairForJob(
    job: Pick<Job, 'type' | 'params'>,
    snapshot: DispatchConfigSnapshot,
  ): { agent: string; model: string } | undefined {
    if (job.type !== 'eval') {
      return undefined;
    }
    const gate = this.gateKeyForEvalType(job.params.eval_type);
    if (gate === undefined) {
      return undefined;
    }
    return resolveGatePair(snapshot.pairs.gateValidators, snapshot.pairs.adviser, gate);
  }

  /**
   * The agent a validator gate job must run on (the effective pair's agent),
   * or undefined so the caller falls through to resolveAgentName. Checked at
   * every agent-resolution point so gate routing survives retries.
   */
  private effectiveGateAgent(
    type: JobType,
    params: Record<string, unknown>,
    snapshot: DispatchConfigSnapshot,
  ): string | undefined {
    return this.effectiveGatePairForJob({ type, params }, snapshot)?.agent;
  }

  private async executeJob(jobId: string, configSnapshot?: DispatchConfigSnapshot): Promise<void> {
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
      // One snapshot governs the whole execution: the agent resolution, the
      // adapter selection, the pinned model, the args, and the timeout all read
      // the same config object, so an edit mid-dispatch (e.g. during the
      // isAvailable subprocess round-trip below) can never pair one config
      // era's agent with another era's model. Passed in by dispatchJob/startJob
      // (the dispatch snapshot); a caller that somehow reaches here without one
      // takes a fresh snapshot.
      const snapshot = configSnapshot ?? this.takeConfigSnapshot();
      // Authoritative execution resolution, all from the ONE snapshot:
      // - adviser jobs keep their creation-stamped agent (deliberate asymmetry);
      // - validator gates re-resolve their chain (retry safety: a stale stamp
      //   from an earlier dispatch era must not pin the gate to an old pair);
      // - every other job keeps its dispatch-time stamp — it was resolved from
      //   this same snapshot at dispatch (or forced explicitly by the caller,
      //   which re-resolution must not override).
      const executionAgent =
        job.type === 'adviser'
          ? job.agentName ?? snapshot.pairs.adviser?.agent ?? this.resolveAgentName(job.type, snapshot)
          : this.effectiveGateAgent(job.type, job.params, snapshot) ?? job.agentName ?? this.resolveAgentName(job.type, snapshot);
      if (executionAgent !== undefined && executionAgent !== job.agentName) {
        // Keep the row's display stamp in sync with what really runs.
        this.stateStore.updateJob(jobId, { agentName: executionAgent });
      }

      const adapter = await this.selectAdapter(executionAgent, snapshot);

      if (!adapter) {
        const available = await this.adapterRegistry.listAvailable();
        const availableNames = available.filter((a) => a.available).map((a) => a.name);
        const allNames = available.map((a) => `${a.name}(${a.available ? 'available' : 'unavailable'})`);
        const requestedAgent =
          executionAgent && executionAgent !== 'default'
            ? executionAgent
            : snapshot.defaultAgent;

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

      const invocation = this.toInvocation(job, adapter.name, snapshot);
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

  private async selectAdapter(
    agentName: string | undefined,
    snapshot: DispatchConfigSnapshot,
  ): Promise<AgentAdapter | null> {
    const requestedAgent =
      agentName && agentName !== 'default'
        ? agentName
        : snapshot.defaultAgent;

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

  private toInvocation(job: Job, adapterName: string, snapshot: DispatchConfigSnapshot): AgentInvocation {
    const rawPrompt = typeof job.params.prompt === 'string' ? job.params.prompt : `Execute ${job.type} job ${job.id}`;
    const prompt = job.type === 'dev'
      ? this.withDevPreamble(rawPrompt, job)
      : job.type === 'integration_test'
        ? this.withIntegrationTestPreamble(rawPrompt, job)
        : rawPrompt;
    // Adviser jobs deliberately get no worker run-context: their edge is full-repo access
    // plus the explicit path pointers composed into the prompt by tenet_ask_adviser, not
    // the worker's narrowed (and inlined) compiled context.
    const context = job.type === 'adviser' ? undefined : this.buildWorkerContext(job);

    const maxTurnsRaw = job.params.maxTurns;
    const maxTurns =
      typeof maxTurnsRaw === 'number' && Number.isFinite(maxTurnsRaw)
        ? Math.max(1, Math.floor(maxTurnsRaw))
        : undefined;

    const workdir = typeof job.params.workdir === 'string' ? job.params.workdir : this.stateStore.projectPath;

    const configuredTimeout = snapshot.timeoutMinutes;
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

    // Global + job-scoped *_args resolve per dispatch from the same snapshot
    // (parseAdapterExtraArgs is pure over the raw object) — an args edit applies
    // from the next dispatched job, no restart. Global args come first so they
    // can influence mode/model before job-scoped flags.
    const argsConfig = parseAdapterExtraArgs(snapshot.raw);
    const adapterKey = ADAPTER_NAME_TO_KEY[adapterName as keyof typeof ADAPTER_NAME_TO_KEY];
    const globalArgs = (adapterKey ? argsConfig[adapterKey] : undefined) ?? [];
    const jobArgs = (adapterKey ? argsConfig.byJobType?.[adapterKey]?.[job.type] : undefined) ?? [];
    const extraArgs = [...globalArgs, ...jobArgs];
    // A pinned model rides invocation.model (adapters strip any manual --model from
    // *_args and place theirs — codex rejects duplicate model flags). Adviser and
    // validator-gate models bind to their configured agent only, so a stray job
    // dispatched by any other path never re-targets the model at a different CLI.
    let model: string | undefined;
    if (job.type === 'adviser') {
      if (snapshot.pairs.adviser && adapterName === snapshot.pairs.adviser.agent) {
        model = snapshot.pairs.adviser.model;
      }
    } else {
      // Validator gates: the effective pair's model wins when it resolved (it
      // also beats default_agent_model when the pair's agent IS the default
      // agent — branch order decides); no pair resolved = today's path untouched.
      const gatePair = this.effectiveGatePairForJob(job, snapshot);
      if (gatePair) {
        if (adapterName === gatePair.agent) {
          model = gatePair.model;
        }
      } else if (snapshot.pairs.defaultAgentModel && adapterName === snapshot.defaultAgent) {
        // Worker model applies only to jobs actually running on the default agent —
        // per-type override agents keep their own CLI default unless *_args say otherwise.
        model = snapshot.pairs.defaultAgentModel;
      }
    }

    return {
      prompt,
      context,
      maxTurns,
      workdir,
      timeoutMs,
      allowedTools,
      extraArgs,
      model,
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
