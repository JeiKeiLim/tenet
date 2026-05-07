import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetReportBlockingFindingTool } from './tenet-report-blocking-finding.js';

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

class ControlledParentAdapter implements AgentAdapter {
  public readonly name = 'mock-adapter';
  private releaseParent: (() => void) | undefined;
  public readonly parentStarted: Promise<void>;
  private resolveParentStarted: (() => void) | undefined;

  constructor() {
    this.parentStarted = new Promise((resolve) => {
      this.resolveParentStarted = resolve;
    });
  }

  release(): void {
    this.releaseParent?.();
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    if (invocation.prompt.includes('parent waits')) {
      this.resolveParentStarted?.();
      await new Promise<void>((resolve) => {
        this.releaseParent = resolve;
      });
      return {
        success: true,
        output: 'parent reported a blocking finding and exited',
        durationMs: 0,
      };
    }

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
  finding: string;
  why_it_blocks_report: string;
  recommended_followup: string;
  suspected_files?: string[];
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; manager: JobManager; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-blocking-finding-test-'));
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
  registerTenetReportBlockingFindingTool(registerTool, manager, store);
  if (!captured) throw new Error('handler not captured');

  return { store, manager, handler: captured };
};

const createHarnessWithAdapter = (
  adapter: AgentAdapter,
): { store: StateStore; manager: JobManager; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-blocking-finding-live-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_dev', adapter.name);
  store.setConfig('agent_override_eval', adapter.name);
  store.setConfig('agent_override_critic_eval', adapter.name);
  store.setConfig('agent_override_playwright_eval', adapter.name);

  const registry = new AdapterRegistry();
  registry.register(adapter);

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
  registerTenetReportBlockingFindingTool(registerTool, manager, store);
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

describe('tenet_report_blocking_finding', () => {
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
      handler({
        job_id: reportJob.id,
        finding: 'bug',
        why_it_blocks_report: 'report would be false',
        recommended_followup: 'fix',
      }),
    ).rejects.toThrow(/report_only=true/);
  });

  it('flips parent to blocked_on_finding and spawns a dev child', async () => {
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
      finding: 'SQLite gets locked',
      why_it_blocks_report: 'final report cannot distinguish product failure from harness lock',
      recommended_followup: 'Add cleanup trap',
      suspected_files: ['scripts/test.sh'],
    });
    const parsed = parseResult(result);

    const parent = store.getJob(reportJob.id);
    expect(parent?.status).toBe('blocked_on_finding');

    const childId = parsed.child_job_id as string;
    const child = store.getJob(childId);
    expect(child?.type).toBe('dev');
    expect(child?.params.blocking_finding_for).toBe(reportJob.id);
    const childPrompt = child?.params.prompt as string;
    expect(childPrompt).toContain('SQLite gets locked');
    expect(childPrompt).toContain('Add cleanup trap');
    expect(childPrompt).toContain('scripts/test.sh');
    expect(parsed.next_tool).toBe('tenet_job_wait');
  });

  it('preserves blocked parent status when the active report-only worker exits', async () => {
    const adapter = new ControlledParentAdapter();
    const { store, manager, handler } = createHarnessWithAdapter(adapter);

    const reportJob = manager.startJob('dev', {
      name: 'final-report',
      prompt: 'parent waits',
      report_only: true,
    });

    await adapter.parentStarted;

    const result = await handler({
      job_id: reportJob.id,
      finding: 'login flow fails',
      why_it_blocks_report: 'final report cannot claim login works',
      recommended_followup: 'repair the login flow',
    });
    const parsed = parseResult(result);

    expect(store.getJob(reportJob.id)?.status).toBe('blocked_on_finding');
    adapter.release();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(store.getJob(reportJob.id)?.status).toBe('blocked_on_finding');

    const preservedEvents = store
      .getEventsForJob(reportJob.id)
      .filter((event) => event.event === 'blocked_finding_parent_exit_preserved');
    expect(preservedEvents.length).toBeGreaterThan(0);
    await manager.waitForJob(parsed.child_job_id as string, null, 5_000);
    expect(store.getJob(parsed.child_job_id as string)?.status).toBe('completed');
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
      finding: 'harness flaky',
      why_it_blocks_report: 'acceptance report would be unreliable',
      recommended_followup: 'cleanup hook',
    });
    const parsed = parseResult(result);
    const childId = parsed.child_job_id as string;

    // Wait for child dev to complete
    await manager.waitForJob(childId, null, 5_000);
    expect(store.getJob(childId)?.status).toBe('completed');
    expect(store.getJob(reportJob.id)?.status).toBe('blocked_on_finding');

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
      finding: 'bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix',
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
    expect(store.getJob(reportJob.id)?.status).toBe('blocked_on_finding');
  });
});
