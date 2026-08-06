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
import { registerTenetReportBlockingFindingTool } from '../mcp/tools/tenet-report-blocking-finding.js';

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

type ReportBlockingFindingHandler = (args: {
  job_id: string;
  finding: string;
  why_it_blocks_report: string;
  recommended_followup: string;
  suspected_files?: string[];
}) => Promise<CallToolResult>;

type Harness = {
  projectPath: string;
  store: StateStore;
  manager: JobManager;
  startEval: StartEvalHandler;
  getStatus: GetStatusHandler;
  reportBlockingFinding: ReportBlockingFindingHandler;
};

const createHarness = (rules: FakeFixtureRule[]): Harness => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-int-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_dev', 'fake');
  store.setConfig('agent_override_eval', 'fake');
  store.setConfig('agent_override_critic_eval', 'fake');
  store.setConfig('agent_override_interaction_e2e', 'fake');

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
    registerTenetGetStatusTool(rt as any, store, manager),
  );
  const reportBlockingFinding = captureHandler<ReportBlockingFindingHandler>((rt) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTenetReportBlockingFindingTool(rt as any, manager, store),
  );

  return { projectPath: tempDir, store, manager, startEval, getStatus, reportBlockingFinding };
};

const parseResult = (r: CallToolResult): Record<string, unknown> => {
  const first = r.content[0];
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
};

const jobId = (parsed: Record<string, unknown>, role: string): string => {
  const jobs = parsed.jobs as Array<Record<string, unknown>>;
  const entry = jobs.find((j) => j.role === role);
  if (!entry) throw new Error(`no dispatched critic with role '${role}'`);
  return entry.job_id as string;
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
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
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
    await manager.waitForJob(jobId(parsed, 'code_critic'), null, 5_000);
    await manager.waitForJob(jobId(parsed, 'test_critic'), null, 5_000);
    await manager.waitForJob(jobId(parsed, 'interaction_e2e'), null, 5_000);

    expect(store.getJob(jobId(parsed, 'code_critic'))?.status).toBe('completed');
    expect(store.getJob(jobId(parsed, 'test_critic'))?.status).toBe('completed');
    expect(store.getJob(jobId(parsed, 'interaction_e2e'))?.status).toBe('completed');
  });

  it('B2: safe verdict → 3 critics launch in parallel', async () => {
    const { store, manager, startEval } = createHarness([
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
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
    const test = store.getJob(jobId(parsed, 'test_critic'));
    const play = store.getJob(jobId(parsed, 'interaction_e2e'));
    expect(test?.parentJobId).toBeUndefined();
    expect(play?.parentJobId).toBeUndefined();

    await manager.waitForJob(jobId(parsed, 'code_critic'), null, 5_000);
    await manager.waitForJob(jobId(parsed, 'test_critic'), null, 5_000);
    await manager.waitForJob(jobId(parsed, 'interaction_e2e'), null, 5_000);
  });
});

// ─── C. Blocking finding auto-resume ────────────────────────────────────────

describe('integration: blocking finding auto-resume', () => {
  it('C1: child dev completes + all 3 critics pass → parent flips to pending', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'harness cleanup bug',
      why_it_blocks_report: 'acceptance report cannot distinguish product failure from cleanup failure',
      recommended_followup: 'Add cleanup trap to tests/setup.sh',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;

    await manager.waitForJob(childId, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

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
    const play = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C2: only one critic passed → parent stays blocked_on_finding', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
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

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
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

    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C3: stale failed critic from an earlier eval round does not block a later all-green round', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Round 1: code_critic FAILS (served once), then falls through to the passing fixture.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const parsed = parseResult(r);
    const childId = parsed.child_job_id as string;

    await manager.waitForJob(childId, null, 5_000);

    const dispatchRound = async (): Promise<void> => {
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
      const play = manager.startJob('interaction_e2e', {
        source_job_id: childId,
        eval_stage: 'interaction_e2e',
        prompt: 'Interaction E2E eval',
      });
      await manager.waitForJob(code.id, null, 5_000);
      await manager.waitForJob(test.id, null, 5_000);
      await manager.waitForJob(play.id, null, 5_000);
    };

    // Round 1: code_critic fails → parent stays blocked.
    await dispatchRound();
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Round 2 (re-fired eval after the child retry): all three pass.
    await dispatchRound();

    // The round-1 failed code_critic must not poison the gate — only the newest
    // critic per stage counts, and round 2 is fully green.
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C4 (round-id): failing round 1 + all-green round 2 → parent resumes on round 2', async () => {
    // NOTE: C4 is a REGRESSION test, not a discriminator — it passes under
    // BOTH per-stage-newest and round-based logic (round 2 is the newest per
    // stage AND the newest complete round). C5 is the true discriminator: it
    // asserts the round gate does NOT mix a round-2 pass with a round-1 pass
    // when round 2 is missing a stage. Keep C5 green when touching the gate.
    const { store, manager, startEval, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    store.setConfig('eval_parallel_safe:credit-fixes', 'true');

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const runRound = async (): Promise<void> => {
      const result = await startEval({ job_id: childId, output: {}, feature: 'credit-fixes' });
      const parsed = parseResult(result);
      for (const role of ['code_critic', 'test_critic', 'interaction_e2e']) {
        const id = jobId(parsed, role);
        await manager.waitForJob(id, null, 5_000);
      }
    };

    // Round 1: code_critic fails → parent stays blocked.
    await runRound();
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Round 2: all pass → parent resumes. The gate keys on the newest round
    // (newest eval_round id), not the newest critic per stage. startEval stamps
    // eval_round on every critic, so this exercises the round-based path.
    await runRound();
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C6 (round-id, sequential): parent stays blocked until the LAST chained critic of the green round completes', async () => {
    const { store, manager, startEval, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    // Sequential mode (default when no parallel verdict): critics run in roster
    // order, each chained after its predecessor completes.
    store.setConfig('eval_parallel_safe:credit-fixes', 'false');

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const ids = async (): Promise<Record<string, string>> => {
      const result = await startEval({ job_id: childId, output: {}, feature: 'credit-fixes' });
      const parsed = parseResult(result);
      const out: Record<string, string> = {};
      for (const role of ['code_critic', 'test_critic', 'interaction_e2e']) {
        out[role] = jobId(parsed, role);
      }
      return out;
    };

    // Round 1: all three chain, code_critic fails → parent stays blocked.
    const round1 = await ids();
    await manager.waitForJob(round1.code_critic, null, 5_000);
    await manager.waitForJob(round1.test_critic, null, 5_000);
    await manager.waitForJob(round1.interaction_e2e, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Round 2: startEval in sequential mode chains test_critic and
    // interaction_e2e as pending behind code_critic — assert the chaining
    // (parentJobId set, eval_round stamped, not running yet) deterministically
    // before any critic completes.
    const round2 = await ids();
    const t2 = store.getJob(round2.test_critic);
    const p2 = store.getJob(round2.interaction_e2e);
    expect(t2?.status).toBe('pending');
    expect(t2?.parentJobId).toBe(round2.code_critic);
    expect(typeof t2?.params.eval_round).toBe('string');
    expect(p2?.status).toBe('pending');
    expect(p2?.parentJobId).toBe(round2.test_critic);
    // Mid-round: the chained critics are still pending, so round 2 is
    // incomplete — the parent must NOT have resumed yet. (The fake adapter
    // completes too fast to assert this after the round finishes, so the
    // pending-chaining assert above is the deterministic mid-round signal.)
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Wait for the whole chained round; only after the LAST critic completes
    // may the parent resume.
    await manager.waitForJob(round2.code_critic, null, 5_000);
    await manager.waitForJob(round2.test_critic, null, 5_000);
    await manager.waitForJob(round2.interaction_e2e, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C5 (round-id): newest round missing a stage does NOT mix with older round (no cross-round unblock)', async () => {
    // The exact scenario the user flagged: round 1's test_critic PASS must NOT
    // combine with round 2's code_critic PASS when round 2 is missing
    // test_critic. Per-stage-newest unblocks (mixing across code revisions);
    // round-based stays blocked (round 2 is incomplete).
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // code_critic: round 1 FAILS, round 2 PASSES (maxUses trick).
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // Round 1: code_critic FAIL (failing fixture), test_critic PASS, interaction_e2e PASS.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    // Round 1: code_critic failed → parent stays blocked.
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Round 2: code_critic PASS, interaction_e2e PASS, but NO test_critic
    // (simulates a critic that wasn't dispatched or context-limited away).
    const r2c = manager.startJob('critic_eval', stamp('round-2', 'code_critic'));
    const r2p = manager.startJob('interaction_e2e', stamp('round-2', 'interaction_e2e'));
    await manager.waitForJob(r2c.id, null, 5_000);
    await manager.waitForJob(r2p.id, null, 5_000);

    // Per-stage-newest would pick: code_critic = round 2 PASS, test_critic =
    // round 1 PASS → UNBLOCK (mixing). Round-based: round 2 is incomplete
    // (missing test_critic) → stays blocked. This is the exact behavior change.
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C7 (round-id): a job-level failed critic in the newest round keeps the parent blocked', async () => {
    const { store, manager, startEval, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Round 1: code_critic FAILS at the rubric level (job completes).
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      // Round 2: code_critic FAILS at the JOB level (adapter success:false).
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json', success: false },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    store.setConfig('eval_parallel_safe:credit-fixes', 'true');

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const runRound = async (): Promise<void> => {
      const result = await startEval({ job_id: childId, output: {}, feature: 'credit-fixes' });
      const parsed = parseResult(result);
      for (const role of ['code_critic', 'test_critic', 'interaction_e2e']) {
        const id = jobId(parsed, role);
        await manager.waitForJob(id, null, 5_000);
      }
    };

    // Round 1: code_critic rubric-fails → parent stays blocked.
    await runRound();
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Round 2: code_critic fails at the job level. The gate must NOT unblock —
    // the status check is the only guard against a failed critic that carried
    // stored passing output.
    await runRound();
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C8 (round-id): an ad-hoc unstamped critic cannot disable the round gate (no cross-round unblock)', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Round 1 code_critic FAILS (served once), then the ad-hoc re-fire PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // Round 1 (stamped): code_critic FAILS, test_critic + interaction_e2e PASS.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Ad-hoc re-fire of code_critic (tenet_start_job-style dispatch): NO
    // eval_round. It PASSES. The round gate must ignore it — round 1's failed
    // code_critic still decides, so the parent stays blocked. (Per-stage-newest
    // would mix the ad-hoc pass with round 1's green critics and unblock.)
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review — ad-hoc re-fire',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C9 (round-id): a legacy unstamped critic newer than the newest round does not unblock', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // code_critic FAILS in round 1 and round 2 (served twice), then the
      // legacy unstamped critic PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 2 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // Round 1 (stamped): code_critic FAILS, test_critic + interaction_e2e PASS.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Round 2 (stamped): code_critic FAILS again, test_critic + interaction_e2e PASS.
    const r2c = manager.startJob('critic_eval', stamp('round-2', 'code_critic'));
    const r2t = manager.startJob('eval', stamp('round-2', 'test_critic'));
    const r2p = manager.startJob('interaction_e2e', stamp('round-2', 'interaction_e2e'));
    await manager.waitForJob(r2c.id, null, 5_000);
    await manager.waitForJob(r2t.id, null, 5_000);
    await manager.waitForJob(r2p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Legacy unstamped code_critic PASSES, created after round 2. The round
    // gate must ignore it — round 2 (newest) has a failed code_critic, so the
    // parent stays blocked. (Per-stage-newest would pick the legacy pass +
    // round 2's green critics and unblock.)
    const legacy = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review — legacy unstamped',
    });
    await manager.waitForJob(legacy.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C10 (round-id): a newer unstamped RED critic cannot be ignored while the parent unblocks on an older green round', async () => {
    // The fail-open direction of the unstamped blind spot: an ad-hoc re-fire
    // (tenet_start_job, no eval_round) that comes back RED must force the gate
    // to wait — not be invisible while the parent unblocks on an older round's
    // stale green. Unstamped siblings become singleton rounds, which can never
    // satisfy "every expected stage present", so the gate stays blocked.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Round 1 code_critic PASSES (served once), then the ad-hoc re-fire FAILS.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // Round 1 (stamped): code_critic + test_critic PASS.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);

    // Round 1's last critic (interaction_e2e) is created, THEN an ad-hoc
    // unstamped code_critic re-fire is created — so the ad-hoc is the NEWEST
    // sibling. It FAILS (passed:false) and must not be invisible to the gate.
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review — ad-hoc re-fire',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);

    // The gate must NOT unblock on round 1's stale green while a newer red
    // evaluation exists.
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C11 (round-id): a malformed expected_eval_stages stamp cannot fail the gate open', async () => {
    // A stamp that filters to an empty set ([123]) must fall back to
    // DEFAULT_EVAL_STAGES — otherwise the stage-presence and completion loops
    // pass trivially and the parent unblocks with no critic evaluated.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // A single-critic round with a malformed stamp: only code_critic exists,
    // so even with the DEFAULT_EVAL_STAGES fallback the round is incomplete.
    const malformed = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      eval_round: 'round-1',
      expected_eval_stages: [123],
      prompt: 'Code Critic review — malformed stamp',
    });
    await manager.waitForJob(malformed.id, null, 5_000);

    // With an empty expectedStages the gate would unblock (both loops pass
    // trivially). With the DEFAULT_EVAL_STAGES fallback it stays blocked.
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C12 (round-id): a cancelled critic in the newest round keeps the parent blocked', async () => {
    // The status check (s.status !== 'completed') is the only guard against a
    // cancelled critic. A cancelled critic must keep the round incomplete —
    // the parent stays blocked until a fresh round is dispatched.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // Round 1 (stamped): cancel test_critic synchronously while it is still
    // pending (before the dispatch loop picks it up).
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    manager.cancelJob(r1t.id);
    expect(store.getJob(r1t.id)?.status).toBe('cancelled');

    // The other two critics complete green, but the round is incomplete
    // (test_critic cancelled) — the parent must stay blocked.
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C13 (round-id): an unstamped singleton cannot self-stamp its way to a complete round', async () => {
    // An ad-hoc re-fire (tenet_start_job) could pass expected_eval_stages:
    // ['code_critic'] and satisfy the gate on one critic's verdict. Unstamped
    // rounds must always require the full DEFAULT_EVAL_STAGES.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Round 1 code_critic FAILS (served once), then the ad-hoc re-fire PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // Round 1 (stamped): code_critic FAILS, test_critic + interaction_e2e PASS.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Ad-hoc unstamped code_critic re-fire carrying a self-serving single-stage
    // stamp. It PASSES and is the newest sibling. It must NOT satisfy the gate.
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      expected_eval_stages: ['code_critic'],
      prompt: 'Code Critic review — self-stamped re-fire',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C14 (per-stage): a green ad-hoc re-fire created long after the round cannot mask a red original', async () => {
    // The 5.5s delay to cross COHORT_WINDOW_MS exceeds the default 5s timeout.
    // All-legacy DB (no eval_round anywhere) → the per-stage fallback runs.
    // A single ad-hoc re-fire created > COHORT_WINDOW_MS after the original
    // round is a partial re-evaluation and must not mask the red original.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Original code_critic FAILS (served once), then the ad-hoc re-fire PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // Original round (no eval_round): code_critic FAILS, test + interaction PASS.
    const c = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const t = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const p = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });
    await manager.waitForJob(c.id, null, 5_000);
    await manager.waitForJob(t.id, null, 5_000);
    await manager.waitForJob(p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Ad-hoc code_critic re-fire created > COHORT_WINDOW_MS later. It PASSES.
    // The per-stage gate must NOT pick it as the newest code_critic and unblock
    // on a partial re-evaluation.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review — ad-hoc re-fire',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  }, 15_000);

  it('C15 (per-stage): a single-critic roster unblocks (consistent with the round gate)', async () => {
    // All-legacy DB → per-stage fallback. A single code_critic carrying
    // expected_eval_stages: ['code_critic'] is a legitimate 1-critic roster
    // (or a self-serving stamp — the two are indistinguishable by shape, and
    // the round gate has no minimum either). The gate unblocks on the one
    // critic's verdict, matching the round gate's behavior for a stamped
    // 1-critic round.
    const { store, manager, reportBlockingFinding } = createHarness([
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

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const single = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      expected_eval_stages: ['code_critic'],
      prompt: 'Code Critic review — self-stamped',
    });
    await manager.waitForJob(single.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C16 (per-stage): a self-serving 2-stage stamp cannot exclude a red stage from the gate', async () => {
    // All-legacy DB → per-stage fallback. The fallback always requires the
    // full DEFAULT_EVAL_STAGES roster — a self-serving 2-stage stamp on an
    // ad-hoc re-fire must not exclude a red stage and unblock.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Original code_critic FAILS (served once), then the ad-hoc re-fire PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      // test_critic FAILS (a red non-re-fired stage the 2-stage stamp excludes).
      { match: matchers.evalStage('test_critic'), fixture: 'critic-failing-with-findings.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // Original round (no eval_round): code FAILS, test FAILS, interaction
    // PASSES. The originals carry the full roster stamp (as a real legacy
    // dispatch would).
    const fullRoster = ['code_critic', 'test_critic', 'interaction_e2e'];
    const c = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      expected_eval_stages: fullRoster,
      prompt: 'Code Critic review',
    });
    const t = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      expected_eval_stages: fullRoster,
      prompt: 'Test Critic review',
    });
    const p = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      expected_eval_stages: fullRoster,
      prompt: 'Interaction E2E eval',
    });
    await manager.waitForJob(c.id, null, 5_000);
    await manager.waitForJob(t.id, null, 5_000);
    await manager.waitForJob(p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Ad-hoc code_critic re-fire with a 2-stage stamp excluding the red
    // test_critic. It PASSES. The gate must still require test_critic (red).
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      expected_eval_stages: ['code_critic', 'interaction_e2e'],
      prompt: 'Code Critic review — 2-stage self-stamp',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C17 (round-id): an unstamped critic older than the newest stamped round is history', async () => {
    // The round gate keys on the newest stamped round. An unstamped critic
    // created between two stamped rounds is an older singleton — it never
    // decides the gate, and a newer full stamped round wins.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // R1 code_critic FAILS (served once), ad-hoc FAILS (served again), R2 PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 2 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // R1 (stamped): code_critic FAILS, test + interaction PASS → blocked.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Ad-hoc unstamped code_critic re-fire (FAILS) created after R1.
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review — ad-hoc re-fire',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // R2 (stamped): all green. The gate keys on R2 (newest stamped round) and
    // unblocks — the older unstamped ad-hoc is history.
    const r2c = manager.startJob('critic_eval', stamp('round-2', 'code_critic'));
    const r2t = manager.startJob('eval', stamp('round-2', 'test_critic'));
    const r2p = manager.startJob('interaction_e2e', stamp('round-2', 'interaction_e2e'));
    await manager.waitForJob(r2c.id, null, 5_000);
    await manager.waitForJob(r2t.id, null, 5_000);
    await manager.waitForJob(r2p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C18 (round-id): on a same-ms createdAt tie, the NEWER round wins (>= tie-break)', async () => {
    // The >= tie-break keeps the later-seen round when two rounds share a max
    // createdAt — with > the older round would win and unblock on stale green.
    // Force a tie by rewriting created_at in the DB.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // R1 code_critic FAILS (served once), R2 code_critic PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // R1 (stamped): code_critic FAILS, test + interaction PASS → blocked.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // R2 (stamped): all green. Force a same-ms tie on created_at BEFORE the
    // dispatch loop runs R2's critics, so both rounds share a max createdAt.
    const r2c = manager.startJob('critic_eval', stamp('round-2', 'code_critic'));
    const r2t = manager.startJob('eval', stamp('round-2', 'test_critic'));
    const r2p = manager.startJob('interaction_e2e', stamp('round-2', 'interaction_e2e'));
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    const tieAt = store.getJob(r1c.id)?.createdAt ?? Date.now();
    for (const id of [r1c.id, r1t.id, r1p.id, r2c.id, r2t.id, r2p.id]) {
      db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(tieAt, id);
    }

    await manager.waitForJob(r2c.id, null, 5_000);
    await manager.waitForJob(r2t.id, null, 5_000);
    await manager.waitForJob(r2p.id, null, 5_000);

    // With >= the later-seen round (R2, green) wins the tie → unblock. With >
    // the older round (R1, red) would win → stay blocked.
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C19 (round-id): a stamped 1-critic round (legitimate roster) unblocks', async () => {
    // A project with a 1-critic roster dispatches a stamped singleton via
    // tenet_start_eval. The round gate must use the consensus roster stamp
    // (['code_critic']), not the full DEFAULT_EVAL_STAGES, or the parent
    // strands forever.
    const { store, manager, reportBlockingFinding } = createHarness([
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

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // A stamped singleton round: eval_round + a single-stage roster stamp.
    const single = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      eval_round: 'round-1',
      expected_eval_stages: ['code_critic'],
      prompt: 'Code Critic review — 1-critic roster',
    });
    await manager.waitForJob(single.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C20 (per-stage): a partial-stamp ad-hoc re-fire cannot shrink the roster when originals are unstamped', async () => {
    // All-legacy DB where the originals predate the expected_eval_stages stamp.
    // A single ad-hoc re-fire carrying a partial stamp must NOT become the
    // consensus roster and exclude a red stage.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // Original code_critic FAILS (served once), then the ad-hoc re-fire PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      // test_critic FAILS (a red stage the partial stamp would exclude).
      { match: matchers.evalStage('test_critic'), fixture: 'critic-failing-with-findings.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // Original round (no eval_round, NO expected_eval_stages — legacy shape):
    // code FAILS, test FAILS, interaction PASSES.
    const c = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const t = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const p = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });
    await manager.waitForJob(c.id, null, 5_000);
    await manager.waitForJob(t.id, null, 5_000);
    await manager.waitForJob(p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // Ad-hoc code_critic re-fire with a partial stamp. It PASSES. The gate
    // must still require test_critic (red) — the partial stamp must not
    // become the consensus when the originals are unstamped.
    const adHoc = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      expected_eval_stages: ['code_critic', 'interaction_e2e'],
      prompt: 'Code Critic review — partial-stamp re-fire',
    });
    await manager.waitForJob(adHoc.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C21 (round-id): a stamped 1-critic round after a larger round (roster shrink) unblocks', async () => {
    // A roster shrink between rounds (a built-in disabled) must be honored:
    // the newest stamped singleton's own roster stamp decides, not the older
    // round's larger consensus.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // R1 code_critic FAILS (served once), R2 code_critic PASSES.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json', maxUses: 1 },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    const stamp = (round: string, stage: string) => {
      const promptLabel = stage === 'code_critic' ? 'Code Critic'
        : stage === 'test_critic' ? 'Test Critic'
        : 'Interaction E2E';
      return {
        source_job_id: childId,
        eval_stage: stage,
        eval_round: round,
        expected_eval_stages: ['code_critic', 'test_critic', 'interaction_e2e'],
        prompt: `${promptLabel} review — stage: ${stage}`,
      };
    };

    // R1 (stamped, 3-critic roster): code_critic FAILS → blocked.
    const r1c = manager.startJob('critic_eval', stamp('round-1', 'code_critic'));
    const r1t = manager.startJob('eval', stamp('round-1', 'test_critic'));
    const r1p = manager.startJob('interaction_e2e', stamp('round-1', 'interaction_e2e'));
    await manager.waitForJob(r1c.id, null, 5_000);
    await manager.waitForJob(r1t.id, null, 5_000);
    await manager.waitForJob(r1p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');

    // R2 (stamped, 1-critic roster after a shrink): code_critic PASSES. The
    // newest singleton's own roster stamp must decide, not the older 3-stage
    // consensus.
    const r2c = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      eval_round: 'round-2',
      expected_eval_stages: ['code_critic'],
      prompt: 'Code Critic review — 1-critic roster',
    });
    await manager.waitForJob(r2c.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('C22 (per-stage): a job-level failed critic with stored passing output cannot unblock', async () => {
    // The per-stage fallback's status guard (s.status !== 'completed') is the
    // only defense against a failed critic that carried stored passing output
    // (setJobOutput runs before the success check).
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      // code_critic FAILS at the JOB level but serves passing output.
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json', success: false },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // All-legacy round (no eval_round): code_critic FAILS at the job level
    // (stored passing output), test + interaction PASS.
    const c = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const t = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const p = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });
    await manager.waitForJob(c.id, null, 5_000);
    await manager.waitForJob(t.id, null, 5_000);
    await manager.waitForJob(p.id, null, 5_000);

    // The failed code_critic's stored passing output must not count — the
    // status guard keeps the parent blocked.
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('C23 (per-stage): a cancelled critic in the fallback gate keeps the parent blocked', async () => {
    // The per-stage fallback's status guard (s.status !== 'completed') is the
    // only defense against a cancelled critic too — the missing cell in the
    // status-guard matrix (C12 covers the round gate, C22 the failed case).
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-clean.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'some bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix it',
    });
    const childId = parseResult(r).child_job_id as string;
    await manager.waitForJob(childId, null, 5_000);

    // All-legacy round (no eval_round): cancel test_critic synchronously
    // while it is still pending.
    const c = manager.startJob('critic_eval', {
      source_job_id: childId,
      eval_stage: 'code_critic',
      prompt: 'Code Critic review',
    });
    const t = manager.startJob('eval', {
      source_job_id: childId,
      eval_stage: 'test_critic',
      prompt: 'Test Critic review',
    });
    const p = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });
    manager.cancelJob(t.id);
    expect(store.getJob(t.id)?.status).toBe('cancelled');

    // code + interaction pass, but the cancelled test_critic keeps the round
    // incomplete — the parent must stay blocked.
    await manager.waitForJob(c.id, null, 5_000);
    await manager.waitForJob(p.id, null, 5_000);
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });
});

// ─── D. Layer 2 status surfacing via tenet_get_status ───────────────────────

describe('integration: latest_e2e_status surfacing', () => {
  const driveOneE2e = async (
    h: Harness,
    rules: FakeFixtureRule[],
  ): Promise<void> => {
    // Update the adapter with new rules by re-registering. Simpler: create a fresh job
    // and wait. We rely on a playwright-specific rule already being in the harness.
    const job = h.manager.startJob('interaction_e2e', {
      source_job_id: 'dummy',
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });
    await h.manager.waitForJob(job.id, null, 5_000);
    void rules;
  };

  it('D1: completed → surfaces "completed"', async () => {
    const h = createHarness([
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);
    await driveOneE2e(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_e2e_status).toBe('completed');
  });

  it('D2: skipped_no_mcp → surfaces "skipped_no_mcp"', async () => {
    const h = createHarness([
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-skipped.json' },
    ]);
    await driveOneE2e(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_e2e_status).toBe('skipped_no_mcp');
  });

  it('D3: failed → surfaces "failed"', async () => {
    const h = createHarness([
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-failed.json' },
    ]);
    await driveOneE2e(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_e2e_status).toBe('failed');
  });

  it('D4: prose braces after the verdict still surface layer2_status (shared-parser regression)', async () => {
    // The old first-{ to last-} slice in tenet_get_status spanned the verdict
    // plus the prose braces, JSON.parse failed, and latest_e2e_status was
    // silently dropped. The shared parser (rubric.ts) must surface it.
    const h = createHarness([
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed-prose-braces.md' },
    ]);
    await driveOneE2e(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_e2e_status).toBe('completed');
  });

  it('D5: unbalanced { in prose before the verdict still surfaces layer2_status (recovery path)', async () => {
    // D4 uses balanced prose braces, so the recovery branch never runs through
    // the tool. This fixture has a stray { (truncated code snippet) before the
    // verdict — the recovery path must surface layer2_status end-to-end.
    const h = createHarness([
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed-unbalanced-brace.md' },
    ]);
    await driveOneE2e(h, []);
    const r = await h.getStatus({});
    const parsed = parseResult(r);
    expect(parsed.latest_e2e_status).toBe('completed');
  });
});

// ─── E. Parser stress tests ─────────────────────────────────────────────────

describe('integration: parser robustness', () => {
  it('E1: critic output with trailing prose still parses → auto-resume proceeds', async () => {
    // This is the stress case that motivated Tier 1: real agents wrap JSON in prose.
    // If extractRubricJson can't handle it, the chain stalls silently in production.
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-passing-trailing-prose.md' },
      { match: matchers.evalStage('test_critic'), fixture: 'critic-passing-trailing-prose.md' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix',
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
    const play = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('pending');
  });

  it('E2: truncated critic output does NOT trigger auto-resume', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-truncated.txt' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix',
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
    const play = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    // code_critic output was truncated — extractRubricJson should not report passed.
    // Therefore the parent must stay blocked.
    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });

  it('E3: failing critic with findings does NOT trigger auto-resume', async () => {
    const { store, manager, reportBlockingFinding } = createHarness([
      { match: matchers.devJob(), fixture: 'dev-with-changes.md' },
      { match: matchers.evalStage('code_critic'), fixture: 'critic-failing-with-findings.json' },
      { match: matchers.evalStage('test_critic'), fixture: 'test-critic-passing.json' },
      { match: matchers.evalStage('interaction_e2e'), fixture: 'playwright-layer2-completed.json' },
    ]);

    const parent = store.createJob({
      type: 'dev',
      status: 'running',
      params: { name: 'final-report', prompt: 'verify', report_only: true },
      retryCount: 0,
      maxRetries: 3,
    });

    const r = await reportBlockingFinding({
      job_id: parent.id,
      finding: 'bug',
      why_it_blocks_report: 'report cannot pass',
      recommended_followup: 'fix',
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
    const play = manager.startJob('interaction_e2e', {
      source_job_id: childId,
      eval_stage: 'interaction_e2e',
      prompt: 'Interaction E2E eval',
    });

    await manager.waitForJob(code.id, null, 5_000);
    await manager.waitForJob(test.id, null, 5_000);
    await manager.waitForJob(play.id, null, 5_000);

    expect(store.getJob(parent.id)?.status).toBe('blocked_on_finding');
  });
});
