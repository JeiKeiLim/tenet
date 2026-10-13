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

  // TASK-056 safeguard: in-place critic retry is legal only for no-verdict
  // failures while no code-writing job completed since the round dispatched.
  describe('critic retry safeguard', () => {
    const RUBRIC_RED =
      '{"passed": false, "stage": "code_critic", "findings": [{"category": "product_bug", "detail": "off by one"}]}';
    const RUBRIC_GREEN = '{"passed": true, "stage": "code_critic", "findings": []}';
    const NO_VERDICT = { output: 'context limit exceeded' }; // infra failure, no rubric JSON

    /** Source dev job + one critic of round-1 evaluating it. */
    const createRound = (
      store: StateStore,
      opts: { status?: 'failed' | 'completed'; output?: unknown; stamped?: boolean } = {},
    ) => {
      const source = store.createJob({
        type: 'dev',
        status: 'completed',
        params: { name: 'source', prompt: 'build' },
        retryCount: 0,
        maxRetries: 3,
      });
      const params: Record<string, unknown> = {
        name: 'critic',
        prompt: 'critique',
        eval_stage: 'code_critic',
        source_job_id: source.id,
      };
      if (opts.stamped !== false) {
        params.eval_round = 'round-1';
      }
      const critic = store.createJob({
        type: 'critic_eval',
        status: opts.status ?? 'failed',
        params,
        retryCount: 0,
        maxRetries: 3,
      });
      if (opts.output !== undefined) {
        store.setJobOutput(critic.id, opts.output);
      }
      return { source, critic };
    };

    it('refuses to re-roll a critic that already produced a RED verdict, naming the fix-loop path', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'failed', output: { output: RUBRIC_RED } });

      await expect(handler({ job_id: critic.id })).rejects.toThrow(
        /already produced a verdict \(passed: false\)[\s\S]*retry the dev job[\s\S]*tenet_start_eval/,
      );
      // Refused before any state change: untouched, still failed, no retry spent.
      expect(store.getJob(critic.id)?.status).toBe('failed');
      expect(store.getJob(critic.id)?.retryCount).toBe(0);
    });

    it('refuses to re-roll a critic that already produced a GREEN verdict', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'completed', output: { output: RUBRIC_GREEN } });

      await expect(handler({ job_id: critic.id })).rejects.toThrow(
        /already produced a verdict \(passed: true\)[\s\S]*nothing to re-run/,
      );
    });

    it('allows the legal case: no-verdict critic, nothing code-writing completed since the round dispatched', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'failed', output: NO_VERDICT });

      const result = await handler({ job_id: critic.id });
      const parsed = parseResult(result);

      expect(parsed.job_id).toBe(critic.id); // in-place: id kept
      expect(parsed.status).toBe('running');
      expect(parsed.retry_count).toBe(1);
      expect(store.getJob(critic.id)?.params.eval_round).toBe('round-1'); // round kept
    });

    it('treats a structured output without a `passed` field as no verdict (retry allowed)', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, {
        status: 'failed',
        output: { output: { summary: 'structured junk, no verdict' } },
      });

      const result = await handler({ job_id: critic.id });
      expect(parseResult(result).status).toBe('running');
    });

    it('refuses after an ad-hoc dev job completes inside the window, naming the offender', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'failed', output: NO_VERDICT });

      const adhoc = store.createJob({
        type: 'dev',
        status: 'pending',
        params: { name: 'hotfix', prompt: 'patch' },
        retryCount: 0,
        maxRetries: 1,
      });
      store.updateJob(adhoc.id, { status: 'completed', completedAt: critic.createdAt + 10 });

      await expect(handler({ job_id: critic.id })).rejects.toThrow(
        /dev job [\s\S]* completed after it[\s\S]*tenet_start_eval/,
      );
    });

    it('refuses after an integration_test job completes inside the window', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'failed', output: NO_VERDICT });

      const e2e = store.createJob({
        type: 'integration_test',
        status: 'pending',
        params: { name: 'checkpoint', prompt: 'verify' },
        retryCount: 0,
        maxRetries: 1,
      });
      store.updateJob(e2e.id, { status: 'completed', completedAt: critic.createdAt + 10 });

      await expect(handler({ job_id: critic.id })).rejects.toThrow(
        /integration_test job [\s\S]* completed after it/,
      );
    });

    it('refuses after the SOURCE job itself re-completes inside the window (source retry)', async () => {
      const { store, handler } = createHarness();
      const { source, critic } = createRound(store, { status: 'failed', output: NO_VERDICT });

      // The orchestrator retried the dev source; it completed again after the round dispatched.
      store.updateJob(source.id, { completedAt: critic.createdAt + 10 });

      await expect(handler({ job_id: critic.id })).rejects.toThrow(/completed after it/);
    });

    it('does not refuse when the only dev completion predates the round dispatch', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'failed', output: NO_VERDICT });

      const early = store.createJob({
        type: 'dev',
        status: 'pending',
        params: { name: 'earlier-dev', prompt: 'old work' },
        retryCount: 0,
        maxRetries: 1,
      });
      store.updateJob(early.id, { status: 'completed', completedAt: critic.createdAt - 100 });

      const result = await handler({ job_id: critic.id });
      expect(parseResult(result).status).toBe('running');
    });

    it('refuses fail-closed when the critic has no eval_round stamp (legacy/ad-hoc row)', async () => {
      const { store, handler } = createHarness();
      const { critic } = createRound(store, { status: 'failed', output: NO_VERDICT, stamped: false });

      await expect(handler({ job_id: critic.id })).rejects.toThrow(
        /no eval_round stamp[\s\S]*tenet_start_eval/,
      );
    });
  });
});
