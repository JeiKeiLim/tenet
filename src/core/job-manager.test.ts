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

  constructor(name: string, delayMs = 0) {
    this.name = name;
    this.delayMs = delayMs;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
    }

    return {
      success: true,
      output: `ok:${invocation.prompt}`,
      durationMs: this.delayMs,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (adapterDelayMs = 0): { store: StateStore; manager: JobManager } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
  const store = new StateStore(tempDir);
  tempDirs.push(tempDir);
  stores.push(store);

  store.setConfig('agent_override_dev', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter('mock-adapter', adapterDelayMs));

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
    expect(result.output).toEqual({
      adapter: 'mock-adapter',
      output: 'ok:build feature',
      duration_ms: 0,
    });
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
