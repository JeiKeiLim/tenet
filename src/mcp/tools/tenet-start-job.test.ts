import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetStartJobTool } from './tenet-start-job.js';

class SlowAdapter implements AgentAdapter {
  public readonly name = 'mock-adapter';

  async invoke(_invocation: AgentInvocation): Promise<AgentResponse> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    return { success: true, output: 'ok', durationMs: 50 };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type Handler = (args: {
  job_id?: string;
  job_type?: 'dev' | 'eval' | 'critic_eval' | 'interaction_e2e' | 'mechanical_eval' | 'compile_context' | 'health_check';
  params?: Record<string, unknown>;
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-start-job-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_dev', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new SlowAdapter());

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 1_000,
    defaultJobTimeoutMs: 2_000,
  });

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetStartJobTool(registerTool, manager);
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

describe('tenet_start_job', () => {
  it('returns the persisted running status and next wait action for registered jobs', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { name: 'build-login', prompt: 'build login' },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await handler({ job_id: job.id });
    const parsed = parseResult(result);

    expect(parsed.job_id).toBe(job.id);
    expect(parsed.status).toBe('running');
    expect(parsed.next_tool).toBe('tenet_job_wait');
    expect(parsed.next_args).toEqual({ job_id: job.id, wait_seconds: 30 });
    expect(store.getJob(job.id)?.status).toBe('running');
  });
});
