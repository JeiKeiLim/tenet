import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { AdapterRegistry } from '../adapters/index.js';
import { FakeAdapter, matchers, type FakeFixtureRule } from '../adapters/fake-adapter.js';
import { JobManager } from './job-manager.js';
import { StateStore } from './state-store.js';
import { registerTenetStartEvalTool } from '../mcp/tools/tenet-start-eval.js';
import { registerTenetGetStatusTool } from '../mcp/tools/tenet-get-status.js';
import { registerTenetRequestRemediationTool } from '../mcp/tools/tenet-request-remediation.js';

// ─── Harness ────────────────────────────────────────────────────────────────
// A full-stack test harness: real StateStore, real JobManager, real AdapterRegistry
// wired to a FakeAdapter. Each scenario asserts against DB state after the
// orchestrator has done its work, exercising the SAME parsers/dispatchers that
// run in production — only the agent CLI is swapped.

const tempDirs: string[] = [];
const stores: StateStore[] = [];

type StartEvalHandler = (args: {
  job_id: string;
  output: Record<string, unknown>;
  feature?: string;
}) => Promise<CallToolResult>;

type GetStatusHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

type RequestRemediationHandler = (args: {
  job_id: string;
  reason: string;
  suggested_fix: string;
  target_files?: string[];
}) => Promise<CallToolResult>;

type Harness = {
  projectPath: string;
  store: StateStore;
  manager: JobManager;
  startEval: StartEvalHandler;
  getStatus: GetStatusHandler;
  requestRemediation: RequestRemediationHandler;
};

const createHarness = (rules: FakeFixtureRule[]): Harness => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-int-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_dev', 'fake');
  store.setConfig('agent_override_eval', 'fake');
  store.setConfig('agent_override_critic_eval', 'fake');
  store.setConfig('agent_override_playwright_eval', 'fake');

  const registry = new AdapterRegistry();
  (registry as unknown as { adapters: Map<string, unknown> }).adapters.clear();
  registry.register(new FakeAdapter(rules));

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 5_000,
    defaultJobTimeoutMs: 5_000,
    maxParallelAgents: 4,
  });

  const captureHandler = <T>(registerFn: (rt: unknown) => void): T => {
    let captured: T | undefined;
    const registerTool = ((_n: string, _d: unknown, h: T) => {
      captured = h;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    registerFn(registerTool);
    if (!captured) throw new Error('handler not captured');
    return captured;
  };

  const startEval = captureHandler<StartEvalHandler>((rt) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTenetStartEvalTool(rt as any, manager, store),
  );
  const getStatus = captureHandler<GetStatusHandler>((rt) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTenetGetStatusTool(rt as any, store),
  );
  const requestRemediation = captureHandler<RequestRemediationHandler>((rt) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTenetRequestRemediationTool(rt as any, manager, store),
  );

  return { projectPath: tempDir, store, manager, startEval, getStatus, requestRemediation };
};

const parseResult = (r: CallToolResult): Record<string, unknown> => {
  const first = r.content[0];
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ─── A. Readiness verdict persistence ───────────────────────────────────────

describe('integration: readiness verdict persistence', () => {
  it('A1: clean JSON with eval_parallel_safe=true → config key is "true"', async () => {
    const { store, manager } = createHarness([
      { match: matchers.evalStage('readiness_validation'), fixture: 'readiness-parallel-safe.json' },
    ]);

    const job = manager.startJob('eval', {
      prompt: 'IMPLEMENTATION READINESS — score this',
      eval_type: 'readiness_validation',
      feature: 'pure-lib',
    });
    await manager.waitForJob(job.id, null, 5_000);

    expect(store.getConfig('eval_parallel_safe:pure-lib')).toBe('true');
  });

  it('A2: fenced JSON with eval_parallel_safe=false → config key is "false"', async () => {
    const { store, manager } = createHarness([
      { match: matchers.evalStage('readiness_validation'), fixture: 'readiness-parallel-unsafe.json' },
    ]);

    const job = manager.startJob('eval', {
      prompt: 'IMPLEMENTATION READINESS — score this',
      eval_type: 'readiness_validation',
      feature: 'stateful-app',
    });
    await manager.waitForJob(job.id, null, 5_000);

    expect(store.getConfig('eval_parallel_safe:stateful-app')).toBe('false');
  });

  it('A3: rubric missing eval_parallel_safe field → config key is NOT set', async () => {
    const { store, manager } = createHarness([
      { match: matchers.evalStage('readiness_validation'), fixture: 'readiness-missing-field.json' },
    ]);

    const job = manager.startJob('eval', {
      prompt: 'IMPLEMENTATION READINESS — score this',
      eval_type: 'readiness_validation',
      feature: 'incomplete-output',
    });
    await manager.waitForJob(job.id, null, 5_000);

    expect(store.getConfig('eval_parallel_safe:incomplete-output')).toBeNull();
  });
});

// ─── B. Sequential critic chain ─────────────────────────────────────────────

describe('integration: sequential critic chain', () => {
  it('B1: unsafe verdict → 3 critics run sequentially and all complete', async () => {
    const { store, manager, startEval } = createHarness([
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);

    // Mark the feature as unsafe — sequential mode
    store.setConfig('eval_parallel_safe:billing', 'false');

    const source = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'build-billing', dag_id: 'job-1', feature: 'billing' },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await startEval({ job_id: source.id, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('sequential');

    // Sequentially: code critic starts running immediately, others pending with parent
    await manager.waitForJob(parsed.code_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.test_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.playwright_eval_job_id as string, null, 5_000);

    expect(store.getJob(parsed.code_critic_job_id as string)?.status).toBe('completed');
    expect(store.getJob(parsed.test_critic_job_id as string)?.status).toBe('completed');
    expect(store.getJob(parsed.playwright_eval_job_id as string)?.status).toBe('completed');
  });

  it('B2: safe verdict → 3 critics launch in parallel', async () => {
    const { store, manager, startEval } = createHarness([
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);

    store.setConfig('eval_parallel_safe:pure', 'true');

    const source = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'build-pure-lib', dag_id: 'job-1', feature: 'pure' },
      retryCount: 0,
      maxRetries: 3,
    });

    const result = await startEval({ job_id: source.id, output: {} });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('parallel');

    // All three should be running (or just-completed) — none were left pending waiting for a parent.
    const test = store.getJob(parsed.test_critic_job_id as string);
    const play = store.getJob(parsed.playwright_eval_job_id as string);
    expect(test?.parentJobId).toBeUndefined();
    expect(play?.parentJobId).toBeUndefined();

    await manager.waitForJob(parsed.code_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.test_critic_job_id as string, null, 5_000);
    await manager.waitForJob(parsed.playwright_eval_job_id as string, null, 5_000);
  });
});

// ─── C. Remediation auto-resume ─────────────────────────────────────────────

describe('integration: remediation auto-resume', () => {
  it('C1: child dev completes + all 3 critics pass → parent flips to pending', async () => {
    const { store, manager, requestRemediation } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await requestRemediation({
      job_id: parent.id,
      reason: 'harness cleanup bug',
      suggested_fix: 'Add cleanup trap to tests/setup.sh',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;

    await manager.waitForJob(childId, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_remediation_required');

    // Orchestrator fires the 3 critics
    const code = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const test = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const play = manager.startJob('playwright_eval', {
      source_job_id: childId,
      eval_stage: 'playwright_eval',
      prompt: 'Playwright eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C2: only one critic passed → parent stays blocked_remediation_required', async () => {
    const { store, manager, requestRemediation } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await requestRemediation({
      job_id: parent.id,
      reason: 'some bug',
      suggested_fix: 'fix it',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;

    await manager.waitForJob(childId, null, 5_000);

    // Only dispatch ONE critic
    const code = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    await manager.waitForJob(code.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('blocked_remediation_required');
  });
});

// ─── D. Layer 2 status surfacing via tenet_get_status ───────────────────────

describe('integration: latest_playwright_layer2_status surfacing', () => {
  const driveOnePlaywright = async (
    h: Harness,
    rules: FakeFixtureRule[],
  ): Promise<void> => {
    // Update the adapter with new rules by re-registering. Simpler: create a fresh job
    // and wait. We rely on a playwright-specific rule already being in the harness.
    const job = h.manager.startJob('playwright_eval', {
      source_job_id: 'dummy',
      eval_stage: 'playwright_eval',
      prompt: 'Playwright eval',
    });
    await h.manager.waitForJob(job.id, null, 5_000);
    void rules;
  };

  it('D1: completed → surfaces "completed"', async () => {
    const h = createHarness([
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);
    await driveOnePlaywright(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_playwright_layer2_status).toBe('completed');
  });

  it('D2: skipped_no_mcp → surfaces "skipped_no_mcp"', async () => {
    const h = createHarness([
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-skipped.json' },
    ]);
    await driveOnePlaywright(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_playwright_layer2_status).toBe('skipped_no_mcp');
  });

  it('D3: failed → surfaces "failed"', async () => {
    const h = createHarness([
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-failed.json' },
    ]);
    await driveOnePlaywright(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_playwright_layer2_status).toBe('failed');
  });
});

// ─── E. Parser stress tests ─────────────────────────────────────────────────

describe('integration: parser robustness', () => {
  it('E1: critic output with trailing prose still parses → auto-resume proceeds', async () => {
    // This is the stress case that motivated Tier 1: real agents wrap JSON in prose.
    // If extractRubricJson can't handle it, the chain stalls silently in production.
    const { store, manager, requestRemediation } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-trailing-prose.md' },
      { match: matchers.evalStage('test_critic'), fixture: 'critic-passing-trailing-prose.md' },
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await requestRemediation({
      job_id: parent.id,
      reason: 'bug',
      suggested_fix: 'fix',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const code = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const test = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const play = manager.startJob('playwright_eval', {
      source_job_id: childId,
      eval_stage: 'playwright_eval',
      prompt: 'Playwright eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('E2: truncated critic output does NOT trigger auto-resume', async () => {
    const { store, manager, requestRemediation } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-truncated.txt' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await requestRemediation({
      job_id: parent.id,
      reason: 'bug',
      suggested_fix: 'fix',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const code = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const test = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const play = manager.startJob('playwright_eval', {
      source_job_id: childId,
      eval_stage: 'playwright_eval',
      prompt: 'Playwright eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    // code_critic output was truncated — extractRubricJson should not report passed.
    // Therefore the parent must stay blocked.
    expect(store.getJob(parent.id)?.status).toBe('blocked_remediation_required');
  });

  it('E3: failing critic with findings does NOT trigger auto-resume', async () => {
    const { store, manager, requestRemediation } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('playwright_eval'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await requestRemediation({
      job_id: parent.id,
      reason: 'bug',
      suggested_fix: 'fix',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const code = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const test = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const play = manager.startJob('playwright_eval', {
      source_job_id: childId,
      eval_stage: 'playwright_eval',
      prompt: 'Playwright eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('blocked_remediation_required');
  });
});
