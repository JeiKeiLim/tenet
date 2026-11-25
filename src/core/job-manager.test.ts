import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../adapters/base.js';
import { AdapterRegistry } from '../adapters/index.js';
import { JobManager, jobManagerConfigForLiveReads, jobManagerConfigFromStateConfig } from './job-manager.js';
import { stateConfigFilePath, UNLIMITED_RETRIES } from './runtime-config.js';
import { StateStore } from './state-store.js';

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  private readonly delayMs: number;
  private readonly outputOverride?: string;
  private readonly available: boolean;
  public calls = 0;
  public lastInvocation?: AgentInvocation;

  constructor(name: string, delayMs = 0, outputOverride?: string, available = true) {
    this.name = name;
    this.delayMs = delayMs;
    this.outputOverride = outputOverride;
    this.available = available;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    this.calls += 1;
    this.lastInvocation = invocation;
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }

    return {
      success: true,
      output: this.outputOverride ?? `ok:${invocation.prompt}`,
      durationMs: this.delayMs,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (
  adapterDelayMs = 0,
  outputOverride?: string,
): { store: StateStore; manager: JobManager; adapter: MockAdapter } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
  const store = new StateStore(tempDir);
  tempDirs.push(tempDir);
  stores.push(store);

  const registry = new AdapterRegistry();
  const adapter = new MockAdapter('mock-adapter', adapterDelayMs, outputOverride);
  registry.register(adapter);

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 100,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 2,
    // Live-config shape: agent selection comes from the per-dispatch config
    // snapshot, exactly as the MCP server's config.json reader provides it.
    readStateConfig: () => ({
      agent_override_dev: 'mock-adapter',
      agent_override_eval: 'mock-adapter',
    }),
  });

  return { store, manager, adapter };
};

const createRegistry = (...adapters: AgentAdapter[]): AdapterRegistry => {
  const registry = new AdapterRegistry();
  const holder = registry as unknown as { adapters: Map<string, AgentAdapter> };
  holder.adapters.clear();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
};

const getServerId = (manager: JobManager): string =>
  (manager as unknown as { serverId: string }).serverId;

/**
 * Adviser/worker-model harness: lets each test pick the adapters and the raw
 * config.json object explicitly — the same object the live reader returns per
 * dispatch, so adviser/gate/worker/args/scalar surfaces all come from one
 * pinned provider.
 */
const createModelHarness = (
  adapters: MockAdapter[],
  rawConfig: Record<string, unknown> = {},
): { projectPath: string; store: StateStore; manager: JobManager; setConfig: (next: Record<string, unknown>) => void } => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-adviser-test-'));
  tempDirs.push(projectPath);

  const store = new StateStore(projectPath);
  stores.push(store);

  const registry = new AdapterRegistry();
  (registry as unknown as { adapters: Map<string, AgentAdapter> }).adapters.clear();
  for (const adapter of adapters) {
    registry.register(adapter);
  }

  // Mutable holder: liveness tests swap the config object between dispatches.
  let currentConfig = rawConfig;
  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 1_000,
    defaultJobTimeoutMs: 2_000,
    readStateConfig: () => currentConfig,
  });

  return {
    projectPath,
    store,
    manager,
    setConfig: (next) => {
      currentConfig = next;
    },
  };
};

const writeRunDocs = (projectPath: string, runPath: string): void => {
  const abs = path.join(projectPath, runPath);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'spec.md'), '# Worker Spec\n\nSpec body.');
  fs.writeFileSync(path.join(abs, 'harness.md'), '# Worker Harness\n\nHarness body.');
  fs.writeFileSync(path.join(abs, 'scenarios.md'), '# Worker Scenarios\n\nScenarios body.');
  fs.writeFileSync(path.join(abs, 'decomposition.md'), '# Worker Decomposition\n\nDAG body.');
};

const runDocParams = (runPath: string): Record<string, unknown> => ({
  feature: 'adviser-demo',
  run_path: runPath,
  artifact_paths: {
    spec: `${runPath}/spec.md`,
    harness: `${runPath}/harness.md`,
    scenarios: `${runPath}/scenarios.md`,
    decomposition: `${runPath}/decomposition.md`,
  },
});

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('JobManager', () => {
  it('starts and completes a job, then returns result', async () => {
    const { manager } = createHarness();

    const job = manager.startJob('dev', { prompt: 'build feature' });
    const waited = await manager.waitForJob(job.id, null, 5_000);

    expect(waited.is_terminal).toBe(true);
    expect(waited.status).toBe('completed');

    const result = manager.getJobResult(job.id);
    expect(result.status).toBe('completed');
    expect(result.job_id).toBe(job.id);
    const output = result.output as { adapter: string; output: string; duration_ms: number };
    expect(output.adapter).toBe('mock-adapter');
    expect(output.duration_ms).toBe(0);
    expect(output.output).toContain('build feature');
    expect(output.output).toContain('Deliverable Requirements');
  });

  it('dev preamble carries the doctrine-drift note contract (journal entry + run-doc marker)', async () => {
    const { manager } = createHarness();
    const job = manager.startJob('dev', { prompt: 'build feature' });
    await manager.waitForJob(job.id, null, 5_000);

    const prompt = (manager.getJobResult(job.id).output as { output: string }).output;

    // The vague "or final report" misroute is gone...
    expect(prompt).not.toContain('or final report');
    // ...replaced by the actual discoverable contract the run-end review depends on.
    expect(prompt).toContain('tenet_update_knowledge(type="journal"');
    expect(prompt).toContain('title="doctrine drift: <file>"');
    expect(prompt).toContain('doctrine_file');
    expect(prompt).toContain('current_claim');
    expect(prompt).toContain('observed_reality');
    expect(prompt).toContain('proposed_change');
    expect(prompt).toContain('### doctrine-drift: <file>');
  });

  it('dev preamble authorizes doctrine edits when allow_project_doctrine_edits is set', async () => {
    const { manager } = createHarness();
    const job = manager.startJob('dev', { prompt: 'maintain doctrine', allow_project_doctrine_edits: true });
    await manager.waitForJob(job.id, null, 5_000);

    const prompt = (manager.getJobResult(job.id).output as { output: string }).output;

    expect(prompt).toContain('explicitly authorized to edit `.tenet/project/**`');
    // Authorized jobs edit doctrine directly, so they are NOT told to write drift notes.
    expect(prompt).not.toContain('title="doctrine drift: <file>"');
  });

  it('cancels a running job', async () => {
    const { store, manager } = createHarness(1_000);

    const job = manager.startJob('dev', { prompt: 'long run' });
    manager.cancelJob(job.id);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    const cancelled = store.getJob(job.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.error).toBe('cancelled by user');
  });

  it('does not fall back to another adapter when the configured adapter is unavailable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const codex = new MockAdapter('codex', 0, undefined, false);
    const claude = new MockAdapter('claude-code');
    const manager = new JobManager(store, createRegistry(codex, claude), {
      heartbeatTimeoutMs: 100,
      defaultJobTimeoutMs: 2_000,
      readStateConfig: () => ({ default_agent: 'codex' }),
    });

    const job = manager.startJob('dev', { prompt: 'build with codex' });
    const waited = await manager.waitForJob(job.id, null, 5_000);

    expect(waited.status).toBe('failed');
    expect(codex.calls).toBe(0);
    expect(claude.calls).toBe(0);
    const output = store.getJobOutput(job.id) as { tried_agent: string; hint: string };
    expect(output.tried_agent).toBe('codex');
    expect(output.hint).toContain('will not switch agents automatically');
  });

  it('passes adapter job-scoped args to matching job type only', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const codex = new MockAdapter('codex');
    const registry = new AdapterRegistry();
    const holder = registry as unknown as { adapters: Map<string, AgentAdapter> };
    holder.adapters.clear();
    registry.register(codex);

    // Job-scoped args ride the live config, resolved per dispatch.
    const manager = new JobManager(store, registry, {
      heartbeatTimeoutMs: 100,
      defaultJobTimeoutMs: 2_000,
      readStateConfig: () => ({
        default_agent: 'codex',
        codex_args_interaction_e2e: '--dangerously-bypass-approvals-and-sandbox',
      }),
    });

    const job = manager.startJob('interaction_e2e', { prompt: 'verify browser' });
    await manager.waitForJob(job.id, null, 5_000);

    expect(codex.lastInvocation?.extraArgs).toEqual(['--dangerously-bypass-approvals-and-sandbox']);

    // Other job types on the same adapter do not get the scoped args.
    const devJob = manager.startJob('dev', { prompt: 'implement' });
    await manager.waitForJob(devJob.id, null, 5_000);
    expect(codex.lastInvocation?.extraArgs).toEqual([]);
  });

  it('does not pick an installed adapter when no agent is configured', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const claude = new MockAdapter('claude-code');
    const manager = new JobManager(store, createRegistry(claude), {
      heartbeatTimeoutMs: 100,
      defaultJobTimeoutMs: 2_000,
    });

    const job = manager.startJob('dev', { prompt: 'build without configured agent' });
    const waited = await manager.waitForJob(job.id, null, 5_000);

    expect(waited.status).toBe('failed');
    expect(claude.calls).toBe(0);
    const output = store.getJobOutput(job.id) as { tried_agent: string | null; hint: string };
    expect(output.tried_agent).toBeNull();
    expect(output.hint).toContain('Set an agent explicitly');
  });

  it('computes continuation over DAG dependencies and all_done transition', () => {
    const { store, manager } = createHarness();

    const root = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'root' },
      retryCount: 0,
      maxRetries: 1,
    });
    const childA = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'child-a' },
      retryCount: 0,
      maxRetries: 1,
      parentJobId: root.id,
    });
    const childB = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'child-b' },
      retryCount: 0,
      maxRetries: 1,
      parentJobId: childA.id,
    });

    const before = manager.continue();
    expect(before.next_job?.id).toBe(root.id);
    expect(before.all_done).toBe(false);

    store.updateJob(root.id, { status: 'completed', completedAt: Date.now() });
    const afterRoot = manager.continue();
    expect(afterRoot.next_job?.id).toBe(childA.id);

    store.updateJob(childA.id, { status: 'completed', completedAt: Date.now() });
    const afterChildA = manager.continue();
    expect(afterChildA.next_job?.id).toBe(childB.id);

    store.updateJob(childB.id, { status: 'completed', completedAt: Date.now() });
    const finalState = manager.continue();
    expect(finalState.next_job).toBeUndefined();
    expect(finalState.all_done).toBe(true);
    expect(finalState.completed_count).toBe(3);
    expect(finalState.total_count).toBe(3);
  });

  it('reports running jobs in continuation and deterministic pending reasons', () => {
    const { store, manager } = createHarness();

    const running = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'active', name: 'active-job' },
      retryCount: 0,
      maxRetries: 1,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    const parent = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'parent', name: 'parent-job' },
      retryCount: 0,
      maxRetries: 1,
    });
    const child = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'child', name: 'child-job' },
      retryCount: 0,
      maxRetries: 1,
      parentJobId: parent.id,
    });

    const state = manager.continue();
    expect(state.running_jobs?.map((j) => j.id)).toContain(running.id);
    expect(state.all_blocked).toBe(false);

    const childStatus = manager.checkJobStatus(child.id, null);
    expect(childStatus.pending_reason).toBe('queued_after_parent');
  });

  it('defaults new jobs to unlimited retries', () => {
    const { store, manager } = createHarness();

    const job = manager.createPendingJob('dev', { prompt: 'retry forever when useful' });

    expect(store.getJob(job.id)?.maxRetries).toBe(UNLIMITED_RETRIES);
  });

  it('allows retrying a job with unlimited retry budget', async () => {
    const { store, manager } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { prompt: 'try again' },
      retryCount: 99,
      maxRetries: UNLIMITED_RETRIES,
      error: 'failed before',
    });

    const retried = manager.retryJob(job.id, 'try again with new evidence');

    // Retry = run-now: the job is re-dispatched immediately, never left pending
    // for a poller that doesn't exist (see retryJob's dispatchJob call).
    expect(retried.status).toBe('running');
    expect(retried.retryCount).toBe(100);
    expect(retried.maxRetries).toBe(UNLIMITED_RETRIES);

    // Let the retried job run to completion so no executeJob dangles after teardown.
    await manager.waitForJob(job.id, null, 5_000);
    expect(store.getJob(job.id)?.status).toBe('completed');
  });

  it('treats zero max retries as no retry budget', () => {
    const { store, manager } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { prompt: 'do not retry' },
      retryCount: 0,
      maxRetries: 0,
      error: 'failed before',
    });

    expect(() => manager.retryJob(job.id)).toThrowError(/exhausted retries \(0\/0\)/);
  });

  it('rejects retrying a non-terminal job', () => {
    const { store, manager } = createHarness();

    const running = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'still running' },
      retryCount: 0,
      maxRetries: 3,
    });

    expect(() => manager.retryJob(running.id)).toThrowError(/can only retry completed or failed jobs/);
  });

  it('rejects retrying when the finite budget is exhausted at the limit', () => {
    const { store, manager } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { prompt: 'no budget left' },
      retryCount: 3,
      maxRetries: 3,
      error: 'failed',
    });

    expect(() => manager.retryJob(job.id)).toThrowError(/exhausted retries \(3\/3\)/);
  });

  it('re-running a completed job counts against the retry budget like any retry', async () => {
    const { store, manager } = createHarness();

    // A re-run of a completed job is still a retry: retryCount increments and the
    // budget gate applies (no exemption for completed-job re-runs).
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { prompt: 're-run me' },
      retryCount: 0,
      maxRetries: 3,
    });

    const rerun = manager.retryJob(job.id);
    expect(rerun.status).toBe('running');
    expect(rerun.retryCount).toBe(1);
    await manager.waitForJob(job.id, null, 5_000);
    expect(store.getJob(job.id)?.status).toBe('completed');
    expect(store.getJob(job.id)?.retryCount).toBe(1);
  });

  it('rejects re-running a completed job when the retry budget is exhausted', () => {
    const { store, manager } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { prompt: 'no budget left' },
      retryCount: 3,
      maxRetries: 3,
    });

    expect(() => manager.retryJob(job.id)).toThrowError(/exhausted retries \(3\/3\)/);
  });

  it('resetJobForRetry is atomic: only the first caller wins the transition', () => {
    const { store } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { prompt: 'retry me' },
      retryCount: 0,
      maxRetries: 3,
      error: 'failed before',
    });

    // First caller wins: completed/failed -> pending, retry_count incremented.
    expect(store.resetJobForRetry(job.id, { prompt: 'retry me' })).toBe(true);
    expect(store.getJob(job.id)?.status).toBe('pending');
    expect(store.getJob(job.id)?.retryCount).toBe(1);

    // Second caller (another server process): status is no longer completed/failed,
    // so the guard rejects the transition — no double increment, no double dispatch.
    expect(store.resetJobForRetry(job.id, { prompt: 'retry me' })).toBe(false);
    expect(store.getJob(job.id)?.retryCount).toBe(1);
  });

  it('resetJobForRetry increments retry_count for a completed job too (re-runs consume the budget)', () => {
    const { store } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { prompt: 're-run me' },
      retryCount: 3,
      maxRetries: 3,
    });

    expect(store.resetJobForRetry(job.id, { prompt: 're-run me' })).toBe(true);
    expect(store.getJob(job.id)?.status).toBe('pending');
    expect(store.getJob(job.id)?.retryCount).toBe(4);
  });

  it('markJobRunning is atomic: only the first caller wins the pending->running transition', () => {
    const { store } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'dispatch me' },
      retryCount: 0,
      maxRetries: 3,
    });

    // First caller wins: pending -> running.
    expect(store.markJobRunning(job.id, 1_000, 'mock-adapter')).toBe(true);
    expect(store.getJob(job.id)?.status).toBe('running');

    // Second caller (another process): status is no longer pending, so the guard
    // rejects the transition — no double dispatch / double execution.
    expect(store.markJobRunning(job.id, 2_000, 'mock-adapter')).toBe(false);
    expect(store.getJob(job.id)?.startedAt).toBe(1_000);
    expect(store.getJob(job.id)?.lastHeartbeat).toBe(1_000);

    // Terminal-state jobs are also rejected by the same guard.
    const terminal = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { prompt: 'done' },
      retryCount: 0,
      maxRetries: 3,
    });
    expect(store.markJobRunning(terminal.id, 3_000, 'mock-adapter')).toBe(false);
    expect(store.getJob(terminal.id)?.status).toBe('completed');
  });

  it('retryJob with enhanced_prompt replaces the prompt for the retried invocation', async () => {
    const { store, manager, adapter } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { prompt: 'original prompt' },
      retryCount: 0,
      maxRetries: 3,
      error: 'failed before',
    });

    const retried = manager.retryJob(job.id, 'NEW EVIDENCE: fix the root cause');
    expect(retried.status).toBe('running');
    await manager.waitForJob(job.id, null, 5_000);

    expect(adapter.calls).toBe(1);
    // The enhanced prompt REPLACES the original (params.prompt = enhancedPrompt),
    // it is not appended to it.
    expect(adapter.lastInvocation?.prompt).toContain('NEW EVIDENCE: fix the root cause');
    expect(adapter.lastInvocation?.prompt).not.toContain('original prompt');
  });

  it('detects stalled running jobs and marks them failed', () => {
    const { store, manager } = createHarness();

    const stale = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'stale' },
      retryCount: 0,
      maxRetries: 1,
      startedAt: Date.now() - 10_000,
      lastHeartbeat: Date.now() - 10_000,
    });
    store.setJobServerId(stale.id, getServerId(manager));

    manager.continue();

    const updated = store.getJob(stale.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toBe('stall detected');
  });

  it('does not reset a fresh running job owned by another server', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const running = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'active', name: 'active-job' },
      retryCount: 0,
      maxRetries: 1,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    store.setJobServerId(running.id, 'server-a');

    const registry = new AdapterRegistry();
    registry.register(new MockAdapter('mock-adapter'));
    new JobManager(store, registry, { heartbeatTimeoutMs: 30 * 60 * 1000 });

    expect(store.getJob(running.id)?.status).toBe('running');
    expect(store.getEventsForJob(running.id).some((event) => event.event === 'job_orphan_reset')).toBe(false);
  });

  it('records stale orphan reset events so pending_reason is not guessed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
    tempDirs.push(tempDir);
    const store = new StateStore(tempDir);
    stores.push(store);

    const orphan = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'orphan', name: 'orphan-job' },
      retryCount: 0,
      maxRetries: 1,
      startedAt: Date.now() - 10_000,
      lastHeartbeat: Date.now() - 10_000,
    });
    store.setJobServerId(orphan.id, 'server-a');

    const registry = new AdapterRegistry();
    registry.register(new MockAdapter('mock-adapter'));
    const manager = new JobManager(store, registry, { heartbeatTimeoutMs: 100 });

    expect(store.getJob(orphan.id)?.status).toBe('pending');
    expect(store.getEventsForJob(orphan.id).some((event) => event.event === 'job_orphan_reset')).toBe(true);
    expect(manager.checkJobStatus(orphan.id, null).pending_reason).toBe(
      'orphan_reset_after_stale_heartbeat',
    );
  });

  it('resets a stale foreign-owned running job during later polling', () => {
    const { store, manager } = createHarness();

    const orphan = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'later orphan', name: 'later-orphan-job' },
      retryCount: 0,
      maxRetries: 1,
      startedAt: Date.now() - 10_000,
      lastHeartbeat: Date.now() - 10_000,
    });
    store.setJobServerId(orphan.id, 'server-a');

    manager.continue();

    expect(store.getJob(orphan.id)?.status).toBe('pending');
    expect(manager.checkJobStatus(orphan.id, null).pending_reason).toBe(
      'orphan_reset_after_stale_heartbeat',
    );
  });

  it('persists eval_parallel_safe verdict to config when readiness eval completes', async () => {
    const rubricJson = JSON.stringify({
      passed: true,
      eval_parallel_safe: false,
      eval_parallel_rationale: 'shared DB',
    });
    const { store, manager } = createHarness(0, rubricJson);

    const job = manager.startJob('eval', {
      prompt: 'readiness',
      eval_type: 'readiness_validation',
      feature: 'oauth',
    });
    await manager.waitForJob(job.id, null, 5_000);

    expect(store.getConfig('eval_parallel_safe:oauth')).toBe('false');
  });

  it('handles rubric JSON wrapped in code fences', async () => {
    const rubricJson =
      '```json\n' + JSON.stringify({ passed: true, eval_parallel_safe: true }) + '\n```';
    const { store, manager } = createHarness(0, rubricJson);

    const job = manager.startJob('eval', {
      prompt: 'readiness',
      eval_type: 'readiness_validation',
      feature: 'payments',
    });
    await manager.waitForJob(job.id, null, 5_000);

    expect(store.getConfig('eval_parallel_safe:payments')).toBe('true');
  });

  it('auto-dispatches pending children marked with auto_dispatch_on_parent_complete', async () => {
    const { store, manager } = createHarness();

    const parent = manager.startJob('eval', { prompt: 'parent' });
    const child = manager.createPendingJob(
      'eval',
      {
        prompt: 'child',
        auto_dispatch_on_parent_complete: true,
      },
      parent.id,
    );

    await manager.waitForJob(parent.id, null, 5_000);
    // Child should have been auto-dispatched
    await manager.waitForJob(child.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('completed');
    expect(store.getJob(child.id)?.status).toBe('completed');
  });

  it('does not auto-dispatch pending children without the flag', async () => {
    const { store, manager } = createHarness();

    const parent = manager.startJob('eval', { prompt: 'parent' });
    const child = manager.createPendingJob(
      'eval',
      { prompt: 'child' }, // no auto_dispatch flag
      parent.id,
    );

    await manager.waitForJob(parent.id, null, 5_000);
    // Give any auto-dispatch a tick to run if it were going to
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(store.getJob(parent.id)?.status).toBe('completed');
    expect(store.getJob(child.id)?.status).toBe('pending');
  });

  it('tracks active concurrency with configured max cap', () => {
    const { store, manager } = createHarness();

    store.createJob({
      type: 'dev',
      status: 'running',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });
    store.createJob({
      type: 'dev',
      status: 'running',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });
    store.createJob({
      type: 'dev',
      status: 'running',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });

    expect(manager.getActiveConcurrency()).toBe(2);
  });

  describe('adviser dispatch and model injection', () => {
    it('gives adviser jobs no worker run-context while an equivalent dev job gets one', async () => {
      const worker = new MockAdapter('mock-worker');
      const adviser = new MockAdapter('claude-code');
      const { projectPath, manager } = createModelHarness(
        [worker, adviser],
        {
          default_agent: 'mock-worker',
          adviser_agent: 'claude-code',
          adviser_model: 'opus',
        },
      );
      const runPath = '.tenet/runs/2026-11-16-adviser-ctx';
      writeRunDocs(projectPath, runPath);
      const params = { name: 'impl-core', prompt: 'Implement the core feature.', ...runDocParams(runPath) };

      const devJob = manager.startJob('dev', params);
      await manager.waitForJob(devJob.id, null, 5_000);
      const devContext = worker.lastInvocation?.context ?? '';
      expect(devContext).toContain('<tenet_run_context>');
      expect(devContext).toContain('# Worker Spec');

      const adviserJob = manager.startAdviserJob({ ...params, name: 'escalation' });
      await manager.waitForJob(adviserJob.id, null, 5_000);

      // The adviser's edge is full-repo access + explicit path pointers in the prompt,
      // not the worker's narrowed (and inlined) compiled context.
      expect(adviser.lastInvocation?.context).toBeUndefined();
      expect(adviser.lastInvocation?.prompt).not.toContain('<tenet_run_context>');
      expect(adviser.lastInvocation?.prompt).toContain('Implement the core feature.');
    });

    it('pins the adviser model and the default-agent model via invocation.model without accumulating', async () => {
      const worker = new MockAdapter('mock-worker');
      const adviser = new MockAdapter('claude-code');
      const { manager } = createModelHarness(
        [worker, adviser],
        {
          default_agent: 'mock-worker',
          default_agent_model: 'sonnet',
          adviser_agent: 'claude-code',
          adviser_model: 'opus[1m]',
          claude_args_adviser: '--allowedTools Read',
        },
      );

      const adviserJob = manager.startAdviserJob({ name: 'escalation', prompt: 'Which option?' });
      await manager.waitForJob(adviserJob.id, null, 5_000);
      // Job-scoped args ride extraArgs; the model rides invocation.model (adapters
      // place it and strip any manual --model) — the adviser's own model is used,
      // never the worker's default_agent_model.
      expect(adviser.lastInvocation?.extraArgs).toEqual(['--allowedTools', 'Read']);
      expect(adviser.lastInvocation?.model).toBe('opus[1m]');

      const first = manager.startJob('dev', { name: 'worker-1', prompt: 'implement' });
      await manager.waitForJob(first.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // Re-dispatch must not accumulate the model pin across dispatches.
      const second = manager.startJob('dev', { name: 'worker-2', prompt: 'implement again' });
      await manager.waitForJob(second.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');
      expect(worker.lastInvocation?.extraArgs).toEqual([]);
    });

    it('does not inject default_agent_model for jobs running on a per-type override agent', async () => {
      const defaultAdapter = new MockAdapter('mock-default');
      const overrideAdapter = new MockAdapter('mock-override');
      const { manager } = createModelHarness(
        [defaultAdapter, overrideAdapter],
        {
          default_agent: 'mock-default',
          default_agent_model: 'sonnet',
          agent_override_eval: 'mock-override',
        },
      );

      const evalJob = manager.startJob('eval', { name: 'code-critic', prompt: 'evaluate' });
      await manager.waitForJob(evalJob.id, null, 5_000);
      expect(overrideAdapter.lastInvocation?.extraArgs).toEqual([]);
      expect(overrideAdapter.lastInvocation?.model).toBeUndefined();

      const devJob = manager.startJob('dev', { name: 'worker', prompt: 'implement' });
      await manager.waitForJob(devJob.id, null, 5_000);
      expect(defaultAdapter.lastInvocation?.model).toBe('sonnet');
    });

    it('never applies the dev deliverables check to adviser jobs', async () => {
      const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-adviser-deliverables-'));
      tempDirs.push(projectPath);
      // A clean git repo makes checkDeliverables fail for a dev job that changed
      // nothing (the exact reason 'adviser' must not be a dev-type job).
      fs.writeFileSync(path.join(projectPath, '.gitignore'), '.tenet/\n');
      execSync('git init', { cwd: projectPath, stdio: 'ignore' });
      execSync('git add .gitignore', { cwd: projectPath, stdio: 'ignore' });
      execSync(
        'git -c user.email=test@example.com -c user.name=TenetTest -c commit.gpgsign=false commit -m init',
        { cwd: projectPath, stdio: 'ignore' },
      );

      const worker = new MockAdapter('mock-worker');
      const adviser = new MockAdapter('claude-code');
      const store = new StateStore(projectPath);
      stores.push(store);
      const registry = new AdapterRegistry();
      (registry as unknown as { adapters: Map<string, AgentAdapter> }).adapters.clear();
      registry.register(worker);
      registry.register(adviser);
      const manager = new JobManager(store, registry, {
        heartbeatTimeoutMs: 1_000,
        defaultJobTimeoutMs: 2_000,
        readStateConfig: () => ({
          default_agent: 'mock-worker',
          adviser_agent: 'claude-code',
          adviser_model: 'opus',
        }),
      });

      // Sanity: the deliverables check is active — a text-only dev job fails.
      const devJob = manager.startJob('dev', { name: 'no-changes', prompt: 'just think about it' });
      const devWait = await manager.waitForJob(devJob.id, null, 5_000);
      expect(devWait.status).toBe('failed');
      expect(store.getJob(devJob.id)?.error).toContain('produced no file changes');

      // The same text-only output from an adviser job is a valid deliverable.
      const adviserJob = manager.startAdviserJob({ name: 'escalation', prompt: 'Which option?' });
      const adviserWait = await manager.waitForJob(adviserJob.id, null, 5_000);
      expect(adviserWait.status).toBe('completed');
      expect(store.getJob(adviserJob.id)?.error).toBeUndefined();
    });

    it('startJob with an explicit agentName dispatches on that agent', async () => {
      const defaultAdapter = new MockAdapter('mock-default');
      const explicitAdapter = new MockAdapter('mock-explicit');
      const { store, manager } = createModelHarness(
        [defaultAdapter, explicitAdapter],
        { default_agent: 'mock-default' },
      );

      const job = manager.startJob('dev', { name: 'explicit-agent', prompt: 'implement' }, {
        agentName: 'mock-explicit',
      });
      expect(job.agentName).toBe('mock-explicit');

      await manager.waitForJob(job.id, null, 5_000);
      expect(store.getJob(job.id)?.agentName).toBe('mock-explicit');
      expect(explicitAdapter.calls).toBe(1);
      expect(defaultAdapter.calls).toBe(0);
    });

    it('keeps the adviser agent and model across a retry', async () => {
      const adviser = new MockAdapter('claude-code');
      const { store, manager } = createModelHarness(
        [adviser],
        {
          default_agent: 'some-other-agent',
          adviser_agent: 'claude-code',
          adviser_model: 'opus',
        },
      );

      const job = manager.startAdviserJob({ name: 'escalation', prompt: 'Which option?' });
      await manager.waitForJob(job.id, null, 5_000);

      const retried = manager.retryJob(job.id);
      expect(retried.agentName).toBe('claude-code');
      expect(retried.status).toBe('running');

      await manager.waitForJob(job.id, null, 5_000);
      expect(adviser.calls).toBe(2);
      expect(adviser.lastInvocation?.model).toBe('opus');
      expect(store.getJob(job.id)?.agentName).toBe('claude-code');
    });
  });

  describe('validator gate dispatch and model injection', () => {
    it('jobManagerConfigFromStateConfig pins the raw config behind a frozen provider', () => {
      const raw = {
        adviser_agent: 'codex',
        adviser_model: 'gpt-6-astra',
        default_agent_model: 'sonnet',
        clarity_agent: 'claude-code',
        clarity_model: 'opus',
      };
      const config = jobManagerConfigFromStateConfig(raw, 'server-1');

      // The frozen variant hands the JobManager the exact raw object — every
      // dispatch surface (pairs, args, scalars) parses from it per dispatch, so
      // no surface can be silently dropped at factory time.
      expect(config.serverId).toBe('server-1');
      expect(config.readStateConfig?.()).toBe(raw);

      // Null/undefined degrade to an empty config, not a crash.
      expect(jobManagerConfigFromStateConfig(null, 'server-2').readStateConfig?.()).toEqual({});
      expect(jobManagerConfigFromStateConfig(undefined, 'server-3').readStateConfig?.()).toEqual({});
    });

    it('jobManagerConfigForLiveReads wires the keep-last-good config.json reader both entry points install', () => {
      const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-live-factory-test-'));
      tempDirs.push(projectPath);
      fs.mkdirSync(path.join(projectPath, '.tenet', '.state'), { recursive: true });
      fs.writeFileSync(
        stateConfigFilePath(projectPath),
        JSON.stringify({ default_agent: 'codex', adviser_agent: 'claude-code', adviser_model: 'opus' }),
        'utf8',
      );

      const config = jobManagerConfigForLiveReads(projectPath, 'server-live');
      expect(config.serverId).toBe('server-live');
      expect(config.readStateConfig?.()).toEqual({
        default_agent: 'codex',
        adviser_agent: 'claude-code',
        adviser_model: 'opus',
      });

      // Live: the next read sees an edit; a torn file keeps the last good
      // object. This is the exact provider src/mcp/index.ts + src/cli/serve.ts
      // install, pinned here because no test can import either entry point.
      fs.writeFileSync(stateConfigFilePath(projectPath), JSON.stringify({ default_agent: 'opencode' }), 'utf8');
      expect(config.readStateConfig?.()).toEqual({ default_agent: 'opencode' });
      fs.writeFileSync(stateConfigFilePath(projectPath), '{ torn', 'utf8');
      expect(config.readStateConfig?.()).toEqual({ default_agent: 'opencode' });
    });

    it('the two gate eval_type literals have no writers outside the validator tools and the core reader', () => {
      // AC #7's "only writers are the two validator tools" needs a pin: a future
      // change that stamps eval_type elsewhere (e.g. tenet_start_eval on critic
      // jobs) would silently route those jobs onto the gate agent.
      const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
            continue;
          }
          const content = fs.readFileSync(full, 'utf8');
          if (/['"](?:clarity_validation|readiness_validation)['"]/.test(content)) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      };
      walk(srcRoot);

      expect(offenders.sort()).toEqual([
        'core/job-manager.ts', // GATE_EVAL_TYPES + persistReadinessVerdict (readers)
        'mcp/tools/tenet-validate-clarity.ts',
        'mcp/tools/tenet-validate-readiness.ts',
      ]);
    });
    it('dispatches each gate on its own pair agent with the pair model pinned (tier 1)', async () => {
      const clarityGate = new MockAdapter('gate-clarity');
      const readinessGate = new MockAdapter('gate-readiness');
      const worker = new MockAdapter('mock-worker');
      const { store, manager } = createModelHarness(
        [clarityGate, readinessGate, worker],
        {
          default_agent: 'mock-worker',
          clarity_agent: 'gate-clarity',
          clarity_model: 'opus',
          readiness_agent: 'gate-readiness',
          readiness_model: 'gpt-6-astra',
        },
      );

      const clarityJob = manager.startJob('eval', {
        name: 'clarity-gate',
        prompt: 'score the interview',
        eval_type: 'clarity_validation',
      });
      expect(clarityJob.agentName).toBe('gate-clarity');
      await manager.waitForJob(clarityJob.id, null, 5_000);
      expect(clarityGate.calls).toBe(1);
      expect(clarityGate.lastInvocation?.model).toBe('opus');
      expect(store.getJob(clarityJob.id)?.agentName).toBe('gate-clarity');

      const readinessJob = manager.startJob('eval', {
        name: 'readiness-gate',
        prompt: 'score readiness',
        eval_type: 'readiness_validation',
      });
      expect(readinessJob.agentName).toBe('gate-readiness');
      await manager.waitForJob(readinessJob.id, null, 5_000);
      expect(readinessGate.lastInvocation?.model).toBe('gpt-6-astra');
      expect(worker.calls).toBe(0);
    });

    it('falls back to the sibling gate pair in both directions (tier 2)', async () => {
      // Readiness configured only: readiness uses its own pair, clarity inherits it.
      const readinessGate = new MockAdapter('gate-readiness');
      const { manager } = createModelHarness(
        [readinessGate, new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          readiness_agent: 'gate-readiness',
          readiness_model: 'gpt-6-astra',
        },
      );

      const clarityJob = manager.startJob('eval', {
        name: 'clarity-gate',
        prompt: 'score',
        eval_type: 'clarity_validation',
      });
      expect(clarityJob.agentName).toBe('gate-readiness');
      await manager.waitForJob(clarityJob.id, null, 5_000);
      expect(readinessGate.lastInvocation?.model).toBe('gpt-6-astra');

      // Clarity configured only: readiness inherits the clarity pair.
      const clarityGate = new MockAdapter('gate-clarity');
      const { manager: manager2 } = createModelHarness(
        [clarityGate, new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          clarity_agent: 'gate-clarity',
          clarity_model: 'opus',
        },
      );

      const readinessJob = manager2.startJob('eval', {
        name: 'readiness-gate',
        prompt: 'score',
        eval_type: 'readiness_validation',
      });
      expect(readinessJob.agentName).toBe('gate-clarity');
      await manager2.waitForJob(readinessJob.id, null, 5_000);
      expect(clarityGate.lastInvocation?.model).toBe('opus');
    });

    it('falls back to the adviser pair for both gates (tier 3)', async () => {
      const adviser = new MockAdapter('gate-adviser');
      const { manager } = createModelHarness(
        [adviser, new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          adviser_agent: 'gate-adviser',
          adviser_model: 'opus',
        },
      );

      for (const evalType of ['clarity_validation', 'readiness_validation'] as const) {
        const job = manager.startJob('eval', {
          name: `${evalType}-gate`,
          prompt: 'score',
          eval_type: evalType,
        });
        expect(job.agentName).toBe('gate-adviser');
        await manager.waitForJob(job.id, null, 5_000);
        expect(adviser.lastInvocation?.model).toBe('opus');
      }
    });

    it('keeps today default path byte-identical when no pair resolves anywhere (tiers 4-5)', async () => {
      const worker = new MockAdapter('mock-worker');
      const { manager } = createModelHarness(
        [worker],
        { default_agent: 'mock-worker', default_agent_model: 'sonnet' },
      );

      // Tier 4: default agent + default_agent_model pin, exactly as before.
      const job = manager.startJob('eval', {
        name: 'clarity-gate',
        prompt: 'score',
        eval_type: 'clarity_validation',
      });
      expect(job.agentName).toBe('mock-worker');
      await manager.waitForJob(job.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // Tier 5: default_agent_model unset = adapter CLI default, no pin.
      const unpinnedWorker = new MockAdapter('mock-worker-2');
      const { manager: manager2 } = createModelHarness(
        [unpinnedWorker],
        { default_agent: 'mock-worker-2' },
      );
      const unpinned = manager2.startJob('eval', {
        name: 'readiness-gate',
        prompt: 'score',
        eval_type: 'readiness_validation',
      });
      await manager2.waitForJob(unpinned.id, null, 5_000);
      expect(unpinnedWorker.lastInvocation?.model).toBeUndefined();
    });

    it('agent_override_eval still wins on the default tier (today resolveAgentName path)', async () => {
      const override = new MockAdapter('mock-override');
      const { manager } = createModelHarness(
        [override, new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          default_agent_model: 'sonnet',
          agent_override_eval: 'mock-override',
        },
      );

      const job = manager.startJob('eval', {
        name: 'clarity-gate',
        prompt: 'score',
        eval_type: 'clarity_validation',
      });
      expect(job.agentName).toBe('mock-override');
      await manager.waitForJob(job.id, null, 5_000);
      // Override agent is not the default agent: no model pin (today's comment contract).
      expect(override.lastInvocation?.model).toBeUndefined();
    });

    it('gate model beats default_agent_model when the pair agent IS the default agent', async () => {
      const worker = new MockAdapter('mock-worker');
      const { manager } = createModelHarness(
        [worker],
        {
          default_agent: 'mock-worker',
          default_agent_model: 'sonnet',
          clarity_agent: 'mock-worker',
          clarity_model: 'opus',
        },
      );

      const gateJob = manager.startJob('eval', {
        name: 'clarity-gate',
        prompt: 'score',
        eval_type: 'clarity_validation',
      });
      await manager.waitForJob(gateJob.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('opus');

      // Workers on the same default agent keep default_agent_model.
      const devJob = manager.startJob('dev', { name: 'worker', prompt: 'implement' });
      await manager.waitForJob(devJob.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');
    });

    it('keeps the gate agent and model across a retry (dispatchJob re-resolution)', async () => {
      const gate = new MockAdapter('gate-clarity');
      const { store, manager } = createModelHarness(
        [gate, new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          clarity_agent: 'gate-clarity',
          clarity_model: 'opus',
        },
      );

      const job = manager.startJob('eval', {
        name: 'clarity-gate',
        prompt: 'score',
        eval_type: 'clarity_validation',
      });
      await manager.waitForJob(job.id, null, 5_000);

      // The regression this pins: dispatchJob re-resolved non-adviser jobs via
      // resolveAgentName('eval') and overwrote the stored gate agent.
      const retried = manager.retryJob(job.id);
      expect(retried.agentName).toBe('gate-clarity');

      await manager.waitForJob(job.id, null, 5_000);
      expect(gate.calls).toBe(2);
      expect(gate.lastInvocation?.model).toBe('opus');
      expect(store.getJob(job.id)?.agentName).toBe('gate-clarity');
      expect(gate.lastInvocation?.prompt).toContain('score');
    });

    it('stamps the effective gate agent on createPendingJob (preflight display consistency)', () => {
      const { manager } = createModelHarness(
        [new MockAdapter('gate-readiness'), new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          readiness_agent: 'gate-readiness',
          readiness_model: 'gpt-6-astra',
        },
      );

      const preflight = manager.createPendingJob('eval', {
        name: 'readiness-preflight',
        prompt: 'deterministic failure',
        eval_type: 'readiness_validation',
      });
      expect(preflight.agentName).toBe('gate-readiness');

      // Non-gate pending jobs keep resolveAgentName (critics chain through here).
      const critic = manager.createPendingJob('eval', {
        name: 'test-critic',
        prompt: 'evaluate',
        eval_stage: 'test_critic',
      });
      expect(critic.agentName).toBe('mock-worker');
    });

    it('isolates every non-gate job from the chain (test critic, critic_eval, dev, ad-hoc eval, adviser)', async () => {
      const gate = new MockAdapter('gate-clarity');
      const adviser = new MockAdapter('gate-adviser');
      const worker = new MockAdapter('mock-worker');
      const { store, manager } = createModelHarness(
        [gate, adviser, worker],
        {
          default_agent: 'mock-worker',
          default_agent_model: 'sonnet',
          adviser_agent: 'gate-adviser',
          adviser_model: 'adviser-opus',
          clarity_agent: 'gate-clarity',
          clarity_model: 'opus',
          readiness_agent: 'gate-clarity',
          readiness_model: 'opus',
        },
      );
      const agentOf = (jobId: string): string | undefined => store.getJob(jobId)?.agentName;

      // Built-in test critic: job type 'eval' with eval_stage, never eval_type.
      const criticJob = manager.startJob('eval', {
        name: 'test-critic',
        prompt: 'evaluate tests',
        eval_stage: 'test_critic',
        source_job_id: 'source-1',
      });
      await manager.waitForJob(criticJob.id, null, 5_000);
      expect(agentOf(criticJob.id)).toBe('mock-worker');
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // critic_eval job type.
      const criticEval = manager.startJob('critic_eval', { name: 'custom-critic', prompt: 'critique' });
      await manager.waitForJob(criticEval.id, null, 5_000);
      expect(agentOf(criticEval.id)).toBe('mock-worker');

      // Ad-hoc eval WITHOUT a validator eval_type.
      const adHoc = manager.startJob('eval', { name: 'adhoc-eval', prompt: 'evaluate' });
      await manager.waitForJob(adHoc.id, null, 5_000);
      expect(agentOf(adHoc.id)).toBe('mock-worker');
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // An eval carrying an eval_type that is NOT one of the two gates.
      const otherType = manager.startJob('eval', {
        name: 'other-eval',
        prompt: 'evaluate',
        eval_type: 'some_other_validation',
      });
      await manager.waitForJob(otherType.id, null, 5_000);
      expect(agentOf(otherType.id)).toBe('mock-worker');

      // interaction_e2e and mechanical_eval (both named in the AC) carrying a
      // STRAY eval_type: the job.type guard — not the absence of eval_type —
      // is what keeps them off the gate agent.
      const e2eJob = manager.startJob('interaction_e2e', {
        name: 'e2e-critic',
        prompt: 'drive the browser',
        eval_type: 'clarity_validation',
      });
      await manager.waitForJob(e2eJob.id, null, 5_000);
      expect(agentOf(e2eJob.id)).toBe('mock-worker');
      expect(worker.lastInvocation?.model).toBe('sonnet');

      const mechanicalJob = manager.startJob('mechanical_eval', {
        name: 'mechanical-checks',
        prompt: 'run checks',
        eval_type: 'readiness_validation',
      });
      await manager.waitForJob(mechanicalJob.id, null, 5_000);
      expect(agentOf(mechanicalJob.id)).toBe('mock-worker');

      // Dev job keeps the default_agent_model pin, never a gate model.
      const devJob = manager.startJob('dev', { name: 'worker', prompt: 'implement' });
      await manager.waitForJob(devJob.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // Adviser job keeps its own pair, never a gate pair.
      const adviserJob = manager.startAdviserJob({ name: 'escalation', prompt: 'Which option?' });
      await manager.waitForJob(adviserJob.id, null, 5_000);
      expect(adviser.lastInvocation?.model).toBe('adviser-opus');

      // And the gate adapter saw only actual gate dispatches: none here.
      expect(gate.calls).toBe(0);
    });

    it('getGateDispatchInfo reports the resolved tier for each gate', () => {
      const { manager } = createModelHarness(
        [new MockAdapter('gate-readiness'), new MockAdapter('gate-adviser'), new MockAdapter('mock-worker')],
        {
          default_agent: 'mock-worker',
          default_agent_model: 'sonnet',
          adviser_agent: 'gate-adviser',
          adviser_model: 'adviser-opus',
          readiness_agent: 'gate-readiness',
          readiness_model: 'gpt-6-astra',
        },
      );

      // Tier 1: own pair.
      expect(manager.getGateDispatchInfo('readiness_validation')).toEqual({
        agent: 'gate-readiness',
        model: 'gpt-6-astra',
        tier: 'gate',
      });
      // Tier 2: sibling pair.
      expect(manager.getGateDispatchInfo('clarity_validation')).toEqual({
        agent: 'gate-readiness',
        model: 'gpt-6-astra',
        tier: 'sibling',
      });

      // Tier 3: adviser pair.
      const { manager: adviserOnly } = createModelHarness(
        [new MockAdapter('gate-adviser')],
        { adviser_agent: 'gate-adviser', adviser_model: 'adviser-opus' },
      );
      expect(adviserOnly.getGateDispatchInfo('clarity_validation')).toEqual({
        agent: 'gate-adviser',
        model: 'adviser-opus',
        tier: 'adviser',
      });

      // Tier 4: default path (override ?? default agent, model pinned on default agent).
      const { manager: noGates } = createModelHarness(
        [new MockAdapter('mock-worker')],
        { default_agent: 'mock-worker', default_agent_model: 'sonnet' },
      );
      expect(noGates.getGateDispatchInfo('clarity_validation')).toEqual({
        agent: 'mock-worker',
        model: 'sonnet',
        tier: 'default',
      });

      // No agent resolves at all: undefined (the dispatch would fail with the stub).
      const { manager: noAgent } = createModelHarness([new MockAdapter('mock-worker')]);
      expect(noAgent.getGateDispatchInfo('clarity_validation')).toBeUndefined();

      // Non-gate eval_types are not gate jobs.
      expect(noAgent.getGateDispatchInfo('something_else')).toBeUndefined();
      expect(noAgent.getGateDispatchInfo(undefined)).toBeUndefined();
    });
  });

  describe('live config reads (per-dispatch snapshot)', () => {
    it('picks up a config edit between two dispatches on the same JobManager — no restart', async () => {
      const worker = new MockAdapter('mock-worker');
      const gate = new MockAdapter('gate-clarity');
      const { manager, setConfig } = createModelHarness(
        [worker, gate],
        {
          default_agent: 'mock-worker',
          default_agent_model: 'sonnet',
          clarity_agent: 'gate-clarity',
          clarity_model: 'opus',
        },
      );

      const devJob = manager.startJob('dev', { name: 'before-edit', prompt: 'implement' });
      await manager.waitForJob(devJob.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // One CLI edit, no restart: the worker model moves and the gate pair flips
      // — both reflected by the NEXT dispatch of the same JobManager.
      setConfig({
        default_agent: 'mock-worker',
        default_agent_model: 'opus-2',
        clarity_agent: 'gate-clarity',
        clarity_model: 'haiku',
      });

      const devJob2 = manager.startJob('dev', { name: 'after-edit', prompt: 'implement' });
      await manager.waitForJob(devJob2.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('opus-2');

      const gateJob = manager.startJob('eval', { name: 'clarity-gate', prompt: 'score', eval_type: 'clarity_validation' });
      await manager.waitForJob(gateJob.id, null, 5_000);
      expect(gate.lastInvocation?.model).toBe('haiku');
      // The reported pair matches the executed one — same live source.
      expect(manager.getGateDispatchInfo('clarity_validation')).toMatchObject({
        agent: 'gate-clarity',
        model: 'haiku',
      });
    });

    it('resolves agent+model from ONE snapshot: a mid-dispatch edit never splits the pair', async () => {
      // Pause INSIDE adapter availability (where a <cli> --version subprocess
      // runs in production): executeJob has taken its snapshot, the adapter has
      // not been invoked yet. An edit landing exactly in that gap must not
      // change what this dispatch runs.
      let signalEntered: () => void = () => {};
      let proceed: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const proceeding = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const gate = new (class extends MockAdapter {
        override async isAvailable(): Promise<boolean> {
          signalEntered();
          await proceeding;
          return true;
        }
      })('gate-clarity');
      const worker = new MockAdapter('mock-worker');
      const { store, manager, setConfig } = createModelHarness(
        [gate, worker],
        {
          default_agent: 'mock-worker',
          clarity_agent: 'gate-clarity',
          clarity_model: 'opus',
        },
      );

      const job = manager.startJob('eval', { name: 'clarity-gate', prompt: 'score', eval_type: 'clarity_validation' });
      await entered; // executeJob is mid-gap: snapshot taken, adapter not invoked
      setConfig({
        default_agent: 'mock-worker',
        clarity_agent: 'gate-clarity',
        clarity_model: 'haiku',
      });
      proceed();

      await manager.waitForJob(job.id, null, 5_000);
      // The in-flight dispatch kept its snapshot's consistent pair...
      expect(gate.lastInvocation?.model).toBe('opus');
      expect(store.getJob(job.id)?.agentName).toBe('gate-clarity');
      expect(worker.calls).toBe(0);
      // ...while the NEXT dispatch sees the edit (one era per dispatch).
      expect(manager.takeConfigSnapshot().pairs.gateValidators).toEqual({
        clarity: { agent: 'gate-clarity', model: 'haiku' },
      });
    });

    it('uses the dispatch-era snapshot through execution: an edit in the dispatch->execute gap does not change what runs', async () => {
      const worker = new MockAdapter('mock-worker');
      const { manager, setConfig } = createModelHarness(
        [worker],
        { default_agent: 'mock-worker', default_agent_model: 'sonnet' },
      );

      // startJob resolves + stamps from the dispatch-era snapshot and schedules
      // executeJob on a setTimeout(0); this synchronous edit lands exactly in
      // that gap. The executed invocation must come from the DISPATCH snapshot
      // (pending jobs pick up config at dispatch) — never a fresh
      // execution-time read, which would also desync the validator tools'
      // reported pair from what really runs.
      const job = manager.startJob('dev', { name: 'gap-edit', prompt: 'implement' });
      setConfig({ default_agent: 'mock-worker', default_agent_model: 'opus-2' });

      await manager.waitForJob(job.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');
    });

    it('stamps max_retries per job at creation — an edit applies to future jobs only', async () => {
      const worker = new MockAdapter('mock-worker');
      const { store, manager, setConfig } = createModelHarness(
        [worker],
        { default_agent: 'mock-worker', max_retries: 1 },
      );

      const first = manager.startJob('dev', { name: 'stamped-1', prompt: 'implement' });
      expect(first.maxRetries).toBe(1);

      setConfig({ default_agent: 'mock-worker', max_retries: 4 });
      const second = manager.startJob('dev', { name: 'stamped-4', prompt: 'implement' });
      expect(second.maxRetries).toBe(4);
      // The already-created job keeps its own creation-time stamp.
      expect(store.getJob(first.id)?.maxRetries).toBe(1);

      await manager.waitForJob(second.id, null, 5_000);
      await manager.waitForJob(first.id, null, 5_000);
    });

    it('applies timeout_minutes per invocation at execution', async () => {
      const worker = new MockAdapter('mock-worker');
      const { manager, setConfig } = createModelHarness(
        [worker],
        { default_agent: 'mock-worker', timeout_minutes: 5 },
      );

      const first = manager.startJob('dev', { name: 'timeout-5', prompt: 'implement' });
      await manager.waitForJob(first.id, null, 5_000);
      expect(worker.lastInvocation?.timeoutMs).toBe(5 * 60 * 1000);

      setConfig({ default_agent: 'mock-worker', timeout_minutes: 90 });
      const second = manager.startJob('dev', { name: 'timeout-90', prompt: 'implement' });
      await manager.waitForJob(second.id, null, 5_000);
      expect(worker.lastInvocation?.timeoutMs).toBe(90 * 60 * 1000);
    });

    it('global and job-scoped args apply per dispatch', async () => {
      const codex = new MockAdapter('codex');
      const { manager, setConfig } = createModelHarness(
        [codex],
        { default_agent: 'codex', codex_args: '--sandbox danger-full-access' },
      );

      const first = manager.startJob('dev', { name: 'args-global', prompt: 'implement' });
      await manager.waitForJob(first.id, null, 5_000);
      expect(codex.lastInvocation?.extraArgs).toEqual(['--sandbox', 'danger-full-access']);

      // Both an args edit AND a previously-unset job-scoped key apply live:
      // global args first, then job-scoped args.
      setConfig({
        default_agent: 'codex',
        codex_args: '--sandbox workspace-write',
        codex_args_interaction_e2e: '--dangerously-bypass-approvals-and-sandbox',
      });
      const second = manager.startJob('interaction_e2e', { name: 'args-e2e', prompt: 'verify' });
      await manager.waitForJob(second.id, null, 5_000);
      expect(codex.lastInvocation?.extraArgs).toEqual([
        '--sandbox',
        'workspace-write',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
    });

    it('a malformed config file keeps the last good dispatch semantics (server keep-last-good)', async () => {
      const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-live-manager-test-'));
      tempDirs.push(projectPath);
      fs.mkdirSync(path.join(projectPath, '.tenet', '.state'), { recursive: true });
      const store = new StateStore(projectPath);
      stores.push(store);
      const worker = new MockAdapter('mock-worker');
      const registry = new AdapterRegistry();
      (registry as unknown as { adapters: Map<string, AgentAdapter> }).adapters.clear();
      registry.register(worker);
      const writeConfig = (content: Record<string, unknown> | string): void => {
        fs.writeFileSync(
          stateConfigFilePath(projectPath),
          typeof content === 'string' ? content : JSON.stringify(content),
          'utf8',
        );
      };

      writeConfig({ default_agent: 'mock-worker', default_agent_model: 'sonnet' });
      // Exactly what both server entry points install (jobManagerConfigForLiveReads).
      const manager = new JobManager(store, registry, jobManagerConfigForLiveReads(projectPath, 'live-server'));

      const first = manager.startJob('dev', { name: 'good-config', prompt: 'implement' });
      await manager.waitForJob(first.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // Torn write mid-session: the running server must keep the last good
      // snapshot, never reset to defaults.
      writeConfig('{ "default_agent": "cod');
      const second = manager.startJob('dev', { name: 'torn-config', prompt: 'implement' });
      await manager.waitForJob(second.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      // Recovery once the file parses again.
      writeConfig({ default_agent: 'mock-worker', default_agent_model: 'opus-2' });
      const third = manager.startJob('dev', { name: 'recovered', prompt: 'implement' });
      await manager.waitForJob(third.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('opus-2');
    });

    it('two concurrent managers converge per dispatch instead of diverging per boot', async () => {
      const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-concurrent-test-'));
      tempDirs.push(projectPath);
      const store = new StateStore(projectPath);
      stores.push(store);
      const worker = new MockAdapter('mock-worker');

      // Two server processes over one project: separate providers, one shared
      // config source (the file). Before live reads, an edit after both booted
      // left both frozen on the old values until restart.
      let current: Record<string, unknown> = {
        default_agent: 'mock-worker',
        default_agent_model: 'sonnet',
      };
      const makeManager = (): JobManager => {
        const registry = new AdapterRegistry();
        (registry as unknown as { adapters: Map<string, AgentAdapter> }).adapters.clear();
        registry.register(worker);
        return new JobManager(store, registry, {
          heartbeatTimeoutMs: 1_000,
          defaultJobTimeoutMs: 2_000,
          readStateConfig: () => current,
        });
      };
      const managerA = makeManager();
      const managerB = makeManager();

      const before = managerA.startJob('dev', { name: 'before-edit', prompt: 'implement' });
      await managerA.waitForJob(before.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('sonnet');

      current = { default_agent: 'mock-worker', default_agent_model: 'opus-2' };

      const viaB = managerB.startJob('dev', { name: 'after-edit-b', prompt: 'implement' });
      await managerB.waitForJob(viaB.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('opus-2');

      const viaA = managerA.startJob('dev', { name: 'after-edit-a', prompt: 'implement' });
      await managerA.waitForJob(viaA.id, null, 5_000);
      expect(worker.lastInvocation?.model).toBe('opus-2');
    });
  });
});
