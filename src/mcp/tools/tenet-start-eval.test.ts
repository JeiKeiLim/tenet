import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetStartEvalTool } from './tenet-start-eval.js';

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    return { success: true, output: `ok:${invocation.prompt.slice(0, 16)}`, durationMs: 0 };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type CapturedHandler = (args: {
  job_id: string;
  output: Record<string, unknown>;
  feature?: string;
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): {
  store: StateStore;
  manager: JobManager;
  handler: CapturedHandler;
} => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-start-eval-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_eval', 'mock-adapter');
  store.setConfig('agent_override_critic_eval', 'mock-adapter');
  store.setConfig('agent_override_playwright_eval', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter('mock-adapter'));

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 500,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 4,
  });

  let captured: CapturedHandler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: CapturedHandler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetStartEvalTool(registerTool, manager, store);

  if (!captured) {
    throw new Error('handler not captured');
  }

  return { store, manager, handler: captured };
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') {
    throw new Error('expected text content');
  }
  return JSON.parse(first.text);
};

const createSourceJob = (store: StateStore, feature?: string): string =>
  store.createJob({
    type: 'dev',
    status: 'completed',
    params: { name: 'source', dag_id: 'job-1', prompt: 'build it', ...(feature ? { feature } : {}) },
    retryCount: 0,
    maxRetries: 3,
  }).id;

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

describe('tenet_start_eval eval mode resolution', () => {
  it('runs critics sequentially when eval_parallel_safe verdict is missing', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(false);
    expect(parsed.execution_mode).toBe('sequential');

    const codeCriticId = parsed.code_critic_job_id as string;
    const testCriticId = parsed.test_critic_job_id as string;
    const playwrightId = parsed.playwright_eval_job_id as string;

    const codeCritic = store.getJob(codeCriticId);
    const testCritic = store.getJob(testCriticId);
    const playwright = store.getJob(playwrightId);

    expect(codeCritic?.status).toBe('running');
    expect(testCritic?.status).toBe('pending');
    expect(testCritic?.parentJobId).toBe(codeCriticId);
    expect(testCritic?.params.auto_dispatch_on_parent_complete).toBe(true);
    expect(playwright?.status).toBe('pending');
    expect(playwright?.parentJobId).toBe(testCriticId);
    expect(playwright?.params.auto_dispatch_on_parent_complete).toBe(true);

    await manager.waitForJob(codeCriticId, null, 5_000);
    await manager.waitForJob(testCriticId, null, 5_000);
    await manager.waitForJob(playwrightId, null, 5_000);
  });

  it('runs critics in parallel when verdict is true', async () => {
    const { store, manager, handler } = createHarness();
    store.setConfig('eval_parallel_safe:oauth', 'true');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(true);
    expect(parsed.execution_mode).toBe('parallel');

    const codeCritic = store.getJob(parsed.code_critic_job_id as string);
    const testCritic = store.getJob(parsed.test_critic_job_id as string);
    const playwright = store.getJob(parsed.playwright_eval_job_id as string);

    expect(codeCritic?.status).toBe('running');
    expect(testCritic?.status).toBe('running');
    expect(playwright?.status).toBe('running');
    expect(testCritic?.parentJobId).toBeUndefined();
    expect(playwright?.parentJobId).toBeUndefined();

    await manager.waitForJob(parsed.code_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.test_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.playwright_eval_job_id as string, null, 5_000);
  });

  it('runs sequentially when verdict is explicitly false', async () => {
    const { store, manager, handler } = createHarness();
    store.setConfig('eval_parallel_safe:oauth', 'false');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(false);
    expect(parsed.execution_mode).toBe('sequential');

    await manager.waitForJob(parsed.code_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.test_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.playwright_eval_job_id as string, null, 5_000);
  });

  it('auto-dispatches the next critic when parent completes', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    const codeCriticId = parsed.code_critic_job_id as string;
    const testCriticId = parsed.test_critic_job_id as string;
    const playwrightId = parsed.playwright_eval_job_id as string;

    await manager.waitForJob(codeCriticId, null, 5_000);
    await manager.waitForJob(testCriticId, null, 5_000);
    await manager.waitForJob(playwrightId, null, 5_000);

    expect(store.getJob(codeCriticId)?.status).toBe('completed');
    expect(store.getJob(testCriticId)?.status).toBe('completed');
    expect(store.getJob(playwrightId)?.status).toBe('completed');
  });

  it('accepts explicit feature param overriding source job feature lookup', async () => {
    const { store, manager, handler } = createHarness();
    store.setConfig('eval_parallel_safe:payments', 'true');
    const sourceId = createSourceJob(store); // no feature on source

    const result = await handler({ job_id: sourceId, output: {}, feature: 'payments' });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(true);

    await manager.waitForJob(parsed.code_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.test_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.playwright_eval_job_id as string, null, 5_000);
  });
});
