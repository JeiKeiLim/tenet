import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetRequestRemediationTool } from './tenet-request-remediation.js';

class PassingAdapter implements AgentAdapter {
  public readonly name = 'mock-adapter';
  async invoke(_invocation: AgentInvocation): Promise<AgentResponse> {
    return {
      success: true,
      output: JSON.stringify({ passed: true, findings: [] }),
      durationMs: 0,
    };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type Handler = (args: {
  job_id: string;
  reason: string;
  suggested_fix: string;
  target_files?: string[];
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; manager: JobManager; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-remediation-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_dev', 'mock-adapter');
  store.setConfig('agent_override_eval', 'mock-adapter');
  store.setConfig('agent_override_critic_eval', 'mock-adapter');
  store.setConfig('agent_override_playwright_eval', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new PassingAdapter());

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 500,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 4,
  });

  let captured: Handler | undefined;
  const registerTool = ((_n: string, _d: unknown, h: Handler) => {
    captured = h;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  registerTenetRequestRemediationTool(registerTool, manager, store);
  if (!captured) throw new Error('handler not captured');

  return { store, manager, handler: captured };
};

const parseResult = (r: CallToolResult): Record<string, unknown> => {
  const f = r.content[0];
  if (f.type !== 'text') throw new Error('expected text');
  return JSON.parse(f.text);
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('tenet_request_remediation', () => {
  it('throws when job is not tagged report_only', async () => {
    const { store, handler } = createHarness();
    const reportJob = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'regular', prompt: 'do thing' },
      retryCount: 0,
      maxRetries: 3,
    });

    await expect(
      handler({ job_id: reportJob.id, reason: 'bug', suggested_fix: 'fix' }),
    ).rejects.toThrow(/report_only=true/);
  });

  it('flips parent to blocked_remediation_required and spawns a dev child', async () => {
    const { store, handler } = createHarness();
    const reportJob = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await handler({
      job_id: reportJob.id,
      reason: 'SQLite gets locked',
      suggested_fix: 'Add cleanup trap',
      target_files: ['scripts/test.sh'],
    });
    const parsed = parseResult(result);

    const parent = store.getJob(reportJob.id);
    expect(parent?.status).toBe('blocked_remediation_required');

    const childId = parsed.child_job_id as string;
    const child = store.getJob(childId);
    expect(child?.type).toBe('dev');
    expect(child?.params.remediation_for).toBe(reportJob.id);
    const childPrompt = child?.params.prompt as string;
    expect(childPrompt).toContain('SQLite gets locked');
    expect(childPrompt).toContain('Add cleanup trap');
    expect(childPrompt).toContain('scripts/test.sh');
  });

  it('auto-resumes parent when all three critic evals for the child pass', async () => {
    const { store, manager, handler } = createHarness();

    const reportJob = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await handler({
      job_id: reportJob.id,
      reason: 'harness flaky',
      suggested_fix: 'cleanup hook',
    });
    const parsed = parseResult(result);
    const childId = parsed.child_job_id as string;

    // Wait for child dev to complete
    await manager.waitForJob(childId, null, 5_000);
    expect(store.getJob(childId)?.status).toBe('completed');
    expect(store.getJob(reportJob.id)?.status).toBe('blocked_remediation_required');

    // Simulate the orchestrator dispatching 3 critic evals for the child
    const codeCritic = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'code critique',
    });
    const testCritic = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'test critique',
    });
    const playwright = manager.startJob('playwright_eval', {
      source_job_id: childId,
      eval_stage: 'playwright_eval',
      prompt: 'playwright',
    });

    await manager.waitForJob(codeCritic.id, null, 5_000);
    await manager.waitForJob(testCritic.id, null, 5_000);
    await manager.waitForJob(playwright.id, null, 5_000);

    // Parent should have auto-resumed to pending
    expect(store.getJob(reportJob.id)?.status).toBe('pending');
  });

  it('does not auto-resume parent if only some critics have passed', async () => {
    const { store, manager, handler } = createHarness();

    const reportJob = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await handler({
      job_id: reportJob.id,
      reason: 'bug',
      suggested_fix: 'fix',
    });
    const parsed = parseResult(result);
    const childId = parsed.child_job_id as string;

    await manager.waitForJob(childId, null, 5_000);

    // Only dispatch one critic
    const codeCritic = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'code critique',
    });
    await manager.waitForJob(codeCritic.id, null, 5_000);

    // Parent stays blocked (only one of three critics has passed)
    expect(store.getJob(reportJob.id)?.status).toBe('blocked_remediation_required');
  });
});
