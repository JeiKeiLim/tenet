import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../adapters/base.js';
import { AdapterRegistry } from '../adapters/index.js';
import { JobManager } from './job-manager.js';
import { UNLIMITED_RETRIES } from './runtime-config.js';
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

  store.setConfig('agent_override_dev', 'mock-adapter');
  store.setConfig('agent_override_eval', 'mock-adapter');

  const registry = new AdapterRegistry();
  const adapter = new MockAdapter('mock-adapter', adapterDelayMs, outputOverride);
  registry.register(adapter);

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 100,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 2,
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
    store.setConfig('default_agent', 'codex');

    const codex = new MockAdapter('codex', 0, undefined, false);
    const claude = new MockAdapter('claude-code');
    const manager = new JobManager(store, createRegistry(codex, claude), {
      heartbeatTimeoutMs: 100,
      defaultJobTimeoutMs: 2_000,
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
    store.setConfig('default_agent', 'codex');

    const codex = new MockAdapter('codex');
    const registry = new AdapterRegistry({
      byJobType: {
        codex: {
          interaction_e2e: ['--dangerously-bypass-approvals-and-sandbox'],
        },
      },
    });
    const holder = registry as unknown as { adapters: Map<string, AgentAdapter> };
    holder.adapters.clear();
    registry.register(codex);

    const manager = new JobManager(store, registry, {
      heartbeatTimeoutMs: 100,
      defaultJobTimeoutMs: 2_000,
    });

    const job = manager.startJob('interaction_e2e', { prompt: 'verify browser' });
    await manager.waitForJob(job.id, null, 5_000);

    expect(codex.lastInvocation?.extraArgs).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
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

  it('completion resets retryCount, so re-running a completed job never exhausts the budget', async () => {
    const { store, manager } = createHarness();

    // A job that failed twice (retryCount=2) with a finite budget of 3.
    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { prompt: 'flaky' },
      retryCount: 2,
      maxRetries: 3,
      error: 'failed before',
    });

    // Third retry consumes the last budget slot and runs.
    const retried = manager.retryJob(job.id);
    expect(retried.status).toBe('running');
    expect(retried.retryCount).toBe(3);
    await manager.waitForJob(job.id, null, 5_000);

    // Completion clears the failure streak: retryCount resets to 0.
    expect(store.getJob(job.id)?.status).toBe('completed');
    expect(store.getJob(job.id)?.retryCount).toBe(0);

    // Re-running the completed job is a fresh start, not a failure retry: it
    // increments to 1, and completion resets it again — re-runs never accumulate.
    const rerun = manager.retryJob(job.id);
    expect(rerun.status).toBe('running');
    expect(rerun.retryCount).toBe(1);
    await manager.waitForJob(job.id, null, 5_000);
    expect(store.getJob(job.id)?.status).toBe('completed');
    expect(store.getJob(job.id)?.retryCount).toBe(0);
  });

  it('dispatchJob is idempotent on an already-running job', () => {
    const { store, manager } = createHarness();

    const job = store.createJob({
      type: 'dev',
      status: 'running',
      params: { prompt: 'already running' },
      retryCount: 0,
      maxRetries: 3,
    });

    const dispatched = manager.dispatchJob(job.id);
    expect(dispatched.status).toBe('running');
    expect(dispatched.id).toBe(job.id);
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
    expect(adapter.lastInvocation?.prompt).toContain('NEW EVIDENCE: fix the root cause');
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
});
