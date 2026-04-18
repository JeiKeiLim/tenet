import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../adapters/base.js';
import { AdapterRegistry } from '../adapters/index.js';
import { JobManager } from './job-manager.js';
import { StateStore } from './state-store.js';

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  private readonly delayMs: number;
  private readonly outputOverride?: string;

  constructor(name: string, delayMs = 0, outputOverride?: string) {
    this.name = name;
    this.delayMs = delayMs;
    this.outputOverride = outputOverride;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
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
    return true;
  }
}

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (
  adapterDelayMs = 0,
  outputOverride?: string,
): { store: StateStore; manager: JobManager } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
  const store = new StateStore(tempDir);
  tempDirs.push(tempDir);
  stores.push(store);

  store.setConfig('agent_override_dev', 'mock-adapter');
  store.setConfig('agent_override_eval', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter('mock-adapter', adapterDelayMs, outputOverride));

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 100,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 2,
  });

  return { store, manager };
};

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

    manager.continue();

    const updated = store.getJob(stale.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toBe('stall detected');
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
