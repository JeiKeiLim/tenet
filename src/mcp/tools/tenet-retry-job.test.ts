import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetRetryJobTool } from './tenet-retry-job.js';

class MockAdapter implements AgentAdapter {
  public readonly name = 'mock-adapter';

  async invoke(_invocation: AgentInvocation): Promise<AgentResponse> {
    return { success: true, output: 'ok', durationMs: 0 };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type Handler = (args: { job_id: string; enhanced_prompt?: string }) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-retry-job-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_dev', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter());

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 1_000,
    defaultJobTimeoutMs: 2_000,
  });

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetRetryJobTool(registerTool, manager);
  if (!captured) throw new Error('handler not captured');

  return { store, handler: captured };
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text);
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_retry_job', () => {
  it('re-dispatches a failed job immediately (run-now) and increments retry count', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { name: 'build-login', prompt: 'build login' },
      retryCount: 0,
      maxRetries: 3,
      error: 'failed before',
    });

    const result = await handler({ job_id: job.id, enhanced_prompt: 'NEW EVIDENCE' });
    const parsed = parseResult(result);

    expect(parsed.job_id).toBe(job.id);
    expect(parsed.status).toBe('running');
    expect(parsed.retry_count).toBe(1);
    expect(parsed.max_retries).toBe(3);
    expect(parsed.retry_limit).toBe('3');
    expect(parsed.next_tool).toBe('tenet_job_wait');
    expect(parsed.next_args).toEqual({ job_id: job.id, wait_seconds: 30 });
    expect(store.getJob(job.id)?.status).toBe('running');
  });

  it('throws when the job does not exist', async () => {
    const { handler } = createHarness();

    await expect(handler({ job_id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/job not found/);
  });

  it('throws when a FAILED job has exhausted its retry budget', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'failed',
      params: { name: 'build-login', prompt: 'build login' },
      retryCount: 3,
      maxRetries: 3,
      error: 'failed before',
    });

    await expect(handler({ job_id: job.id })).rejects.toThrow(/exhausted retries \(3\/3\)/);
  });

  it('throws when a COMPLETED job has exhausted its retry budget (re-runs are not exempt)', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'build-login', prompt: 'build login' },
      retryCount: 3,
      maxRetries: 3,
    });

    await expect(handler({ job_id: job.id })).rejects.toThrow(/exhausted retries \(3\/3\)/);
  });

  it('re-runs a completed job within budget and increments retry count', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'build-login', prompt: 'build login' },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await handler({ job_id: job.id });
    const parsed = parseResult(result);

    expect(parsed.status).toBe('running');
    expect(parsed.retry_count).toBe(1);
    expect(store.getJob(job.id)?.status).toBe('running');
  });
});
