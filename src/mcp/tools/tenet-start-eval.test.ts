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
  output?: Record<string, unknown>;
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
  store.setConfig('agent_override_interaction_e2e', 'mock-adapter');

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

const jobId = (parsed: Record<string, unknown>, role: string): string => {
  const jobs = parsed.jobs as Array<Record<string, unknown>>;
  const entry = jobs.find((j) => j.role === role);
  if (!entry) {
    throw new Error(`no dispatched critic with role '${role}'; roles were: ${jobs.map((j) => j.role).join(', ')}`);
  }
  return entry.job_id as string;
};

const jobRoles = (parsed: Record<string, unknown>): string[] =>
  (parsed.jobs as Array<Record<string, unknown>>).map((j) => j.role as string);

const writeRoster = (store: StateStore, roster: unknown): void => {
  fs.writeFileSync(
    path.join(store.projectPath, '.tenet', 'critics.json'),
    typeof roster === 'string' ? roster : JSON.stringify(roster),
    'utf8',
  );
};

const writeCriticPrompt = (store: StateStore, name: string, body: string): void => {
  const dir = path.join(store.projectPath, '.tenet', 'critics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
};

const createSourceJob = (
  store: StateStore,
  feature?: string,
  extraParams: Record<string, unknown> = {},
): string =>
  store.createJob({
    type: 'dev',
    status: 'completed',
    params: { name: 'source', dag_id: 'job-1', prompt: 'build it', ...(feature ? { feature } : {}), ...extraParams },
    retryCount: 0,
    maxRetries: 3,
  }).id;

const waitForAll = async (manager: JobManager, parsed: Record<string, unknown>): Promise<void> => {
  const jobs = parsed.jobs as Array<Record<string, unknown>>;
  for (const j of jobs) {
    await manager.waitForJob(j.job_id as string, null, 5_000);
  }
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

describe('tenet_start_eval eval mode resolution', () => {
  it('dispatches hybrid when eval_parallel_safe verdict is missing — default roster: code ∥ (test → e2e)', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(false);
    expect(parsed.execution_mode).toBe('hybrid');
    expect(parsed.critics_dispatched).toBe(3);
    expect(parsed.parallel_critics).toBe(1);
    expect(parsed.sequential_critics).toBe(2);

    const codeCriticId = jobId(parsed, 'code_critic');
    const testCriticId = jobId(parsed, 'test_critic');
    const playwrightId = jobId(parsed, 'interaction_e2e');

    const codeCritic = store.getJob(codeCriticId);
    const testCritic = store.getJob(testCriticId);
    const playwright = store.getJob(playwrightId);

    // Parallel lane (code_critic — a read-only conformance critic) and the
    // sequential lane head both start immediately; the lanes overlap.
    expect(codeCritic?.status).toBe('running');
    expect(codeCritic?.parentJobId).toBeUndefined();
    expect(testCritic?.status).toBe('running');
    expect(testCritic?.parentJobId).toBeUndefined();
    // The rest of the sequential lane chains on its own head, roster order.
    expect(playwright?.status).toBe('pending');
    expect(playwright?.parentJobId).toBe(testCriticId);
    expect(playwright?.params.auto_dispatch_on_parent_complete).toBe(true);

    await waitForAll(manager, parsed);
  });

  it('runs critics in parallel when verdict is true', async () => {
    const { store, manager, handler } = createHarness();
    store.setConfig('eval_parallel_safe:oauth', 'true');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(true);
    expect(parsed.execution_mode).toBe('parallel');

    const codeCritic = store.getJob(jobId(parsed, 'code_critic'));
    const testCritic = store.getJob(jobId(parsed, 'test_critic'));
    const playwright = store.getJob(jobId(parsed, 'interaction_e2e'));

    expect(codeCritic?.status).toBe('running');
    expect(testCritic?.status).toBe('running');
    expect(playwright?.status).toBe('running');
    expect(testCritic?.parentJobId).toBeUndefined();
    expect(playwright?.parentJobId).toBeUndefined();
    expect((parsed.jobs as Array<Record<string, unknown>>).every((j) => j.lane === 'parallel')).toBe(true);

    await waitForAll(manager, parsed);
  });

  it('ignores parallel_safe flags when the verdict is true — everything runs in parallel', async () => {
    const { store, manager, handler } = createHarness();
    // Even with every critic flagged sequential, the feature was proven stateless.
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, parallel_safe: false },
        { id: 'test_critic', builtin: true, parallel_safe: false },
        { id: 'interaction_e2e', builtin: true, parallel_safe: false },
      ],
    });
    store.setConfig('eval_parallel_safe:oauth', 'true');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('parallel');
    expect(parsed.parallel_critics).toBe(3);
    for (const role of ['code_critic', 'test_critic', 'interaction_e2e']) {
      const job = store.getJob(jobId(parsed, role));
      expect(job?.status).toBe('running');
      expect(job?.parentJobId).toBeUndefined();
    }

    await waitForAll(manager, parsed);
  });

  it('runs fully sequentially when the verdict is false and every critic is flagged parallel_safe: false', async () => {
    const { store, manager, handler } = createHarness();
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, parallel_safe: false },
        { id: 'test_critic', builtin: true, parallel_safe: false },
        { id: 'interaction_e2e', builtin: true, parallel_safe: false },
      ],
    });
    store.setConfig('eval_parallel_safe:oauth', 'false');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(false);
    expect(parsed.execution_mode).toBe('sequential');
    expect(parsed.sequential_critics).toBe(3);

    const jobs = parsed.jobs as Array<Record<string, unknown>>;
    expect(jobs[0].parent_job_id).toBeUndefined();
    expect(jobs[1].parent_job_id).toBe(jobs[0].job_id);
    expect(jobs[2].parent_job_id).toBe(jobs[1].job_id);

    await waitForAll(manager, parsed);
  });

  it('hybrid: parallel_safe critics run concurrently while the rest chain among themselves', async () => {
    const { store, manager, handler } = createHarness();
    writeCriticPrompt(store, 'extra.md', '## Extra Critic — reachability.\n');
    writeCriticPrompt(store, 'lint.md', '## Lint Critic — style.\n');
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true }, // parallel_safe defaults true
        { id: 'test_critic', builtin: true }, // defaults false
        { id: 'interaction_e2e', builtin: true }, // defaults false
        { id: 'extra', builtin: false, stage: 'extra_critic', prompt_file: '.tenet/critics/extra.md', parallel_safe: true },
        { id: 'lint', builtin: false, stage: 'lint_critic', prompt_file: '.tenet/critics/lint.md' }, // custom default false
      ],
    });
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('hybrid');
    expect(parsed.parallel_critics).toBe(2);
    expect(parsed.sequential_critics).toBe(3);

    // Parallel lane (roster order preserved): code + extra start immediately.
    expect(store.getJob(jobId(parsed, 'code_critic'))?.status).toBe('running');
    expect(store.getJob(jobId(parsed, 'extra_critic'))?.status).toBe('running');

    // Sequential lane chains among itself, interleaved roster order or not:
    // test (head) → interaction_e2e → lint.
    const testId = jobId(parsed, 'test_critic');
    const e2eId = jobId(parsed, 'interaction_e2e');
    const lintId = jobId(parsed, 'lint_critic');
    expect(store.getJob(testId)?.status).toBe('running');
    expect(store.getJob(e2eId)?.status).toBe('pending');
    expect(store.getJob(e2eId)?.parentJobId).toBe(testId);
    expect(store.getJob(lintId)?.status).toBe('pending');
    expect(store.getJob(lintId)?.parentJobId).toBe(e2eId);

    await waitForAll(manager, parsed);
  });

  it('reports parallel (not hybrid) when every critic is parallel_safe under a false verdict', async () => {
    const { store, manager, handler } = createHarness();
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true },
        { id: 'test_critic', builtin: true, parallel_safe: true },
        { id: 'interaction_e2e', builtin: true, parallel_safe: true },
      ],
    });
    store.setConfig('eval_parallel_safe:oauth', 'false');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('parallel');
    expect(parsed.parallel_critics).toBe(3);
    expect(parsed.sequential_critics).toBe(0);

    await waitForAll(manager, parsed);
  });

  it('auto-dispatches the next critic when parent completes', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    const codeCriticId = jobId(parsed, 'code_critic');
    const testCriticId = jobId(parsed, 'test_critic');
    const playwrightId = jobId(parsed, 'interaction_e2e');

    await waitForAll(manager, parsed);

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

    await waitForAll(manager, parsed);
  });

  it('degrades gracefully when output is omitted — dispatches critics with empty output (#29)', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    // No `output` supplied. The schema defaults it to {} instead of failing closed, so a stuck
    // host agent can no longer wedge itself on a missing required arg — critics just get less.
    const result = await handler({ job_id: sourceId });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(3);
    const codeCritic = store.getJob(jobId(parsed, 'code_critic'));
    const testCritic = store.getJob(jobId(parsed, 'test_critic'));
    expect((codeCritic?.params.prompt as string).includes('## Worker Output\n\n{}')).toBe(true);
    expect((testCritic?.params.prompt as string).includes('## Worker Output\n\n{}')).toBe(true);
    // The fabricated precision statistic is gone from every critic prompt.
    expect((codeCritic?.params.prompt as string).includes('~6%')).toBe(false);
    expect((testCritic?.params.prompt as string).includes('~6%')).toBe(false);

    await waitForAll(manager, parsed);
  });

  it('code critic prompt treats unauthorized project doctrine edits as scope_conflict', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth', {
      run_slug: '2026-06-12-oauth',
      run_path: '.tenet/runs/2026-06-12-oauth',
      artifact_paths: {
        spec: '.tenet/runs/2026-06-12-oauth/spec.md',
        harness: '.tenet/runs/2026-06-12-oauth/harness.md',
      },
    });

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);
    const codeCritic = store.getJob(jobId(parsed, 'code_critic'));
    const prompt = codeCritic?.params.prompt as string;

    expect(prompt).toContain('Project doctrine edits authorized**: no');
    expect(prompt).toContain('any change under `.tenet/project/**` is OUT OF SCOPE');
    expect(prompt).toContain('Also use "scope_conflict" when project doctrine edits are not authorized');
    expect(prompt).toContain('**Run path**: .tenet/runs/2026-06-12-oauth');
    expect(prompt).toContain('**Artifact paths**');

    await waitForAll(manager, parsed);
  });

  it('playwright eval prompt uses exact artifacts and project docs instead of legacy harness path', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);
    const playwright = store.getJob(jobId(parsed, 'interaction_e2e'));
    const prompt = playwright?.params.prompt as string;

    expect(prompt).toContain('Use exact artifact_paths when provided');
    expect(prompt).toContain('.tenet/project/testing.md');
    expect(prompt).toContain('.tenet/project/design.md');
    expect(prompt).not.toContain('.tenet/harness/current.md');

    // Reframe (#10): agent-brain QA is a first-class principle for EVERY surface,
    // with browser demoted to one peer branch and CLI/API/library getting real
    // exploratory guidance (not just "run the declared commands").
    expect(prompt).toContain('Apply agent-brain QA to your surface (ALL surfaces)');
    expect(prompt).toContain('### Browser surface (web_ui / visual / canvas)');
    expect(prompt).toContain('### CLI surface');
    expect(prompt).toContain('### API surface');
    expect(prompt).toContain('### Library surface');
    expect(prompt).toContain('--help'); // CLI exploratory probing
    expect(prompt).toContain('confirm the exit code is non-zero'); // CLI error-path rigor
    expect(prompt).toContain('SEMANTICS, not just non-5xx'); // API exploratory rigor
    // Output contract is unchanged (back-compat for the gate + status surfacing).
    expect(prompt).toContain(
      'End with: {"passed": true/false, "stage": "interaction_e2e", "surface": "web_ui|visual|cli|api|library|none", "layer2_status": "completed|skipped_no_mcp|not_applicable|failed", "scripted_results": "...", "exploratory_findings": ["..."], "screenshots": ["..."]}',
    );

    await waitForAll(manager, parsed);
  });

  it('propagates source artifact_paths + run_path onto critic jobs so they get inlined run docs', async () => {
    const { store, handler } = createHarness();
    const runPath = '.tenet/runs/2026-07-02-critic-ctx';
    const sourceId = createSourceJob(store, 'critic-ctx', {
      run_path: runPath,
      artifact_paths: {
        spec: `${runPath}/spec.md`,
        scenarios: `${runPath}/scenarios.md`,
        harness: `${runPath}/harness.md`,
        decomposition: `${runPath}/decomposition.md`,
      },
    });

    const parsed = parseResult(await handler({ job_id: sourceId, output: { done: true } }));
    const codeCritic = store.getJob(jobId(parsed, 'code_critic'));

    // The critic job carries the run's artifact_paths + run_path so buildWorkerContext
    // (run on dispatch) inlines the same spec/scenarios/decomposition/harness the dev
    // worker sees — a critic evaluates against the real spec, not a label pointing at it.
    expect(codeCritic?.params.run_path).toBe(runPath);
    expect(codeCritic?.params.artifact_paths).toEqual({
      spec: `${runPath}/spec.md`,
      scenarios: `${runPath}/scenarios.md`,
      harness: `${runPath}/harness.md`,
      decomposition: `${runPath}/decomposition.md`,
    });
    // The false "you receive the spec" claim is gone (the docs are now actually inlined).
    expect(codeCritic?.params.prompt).not.toContain('You receive ONLY');

    // interaction_e2e defaults to ungrounded (it acts like a user) — no inlined docs.
    const e2e = store.getJob(jobId(parsed, 'interaction_e2e'));
    expect(e2e?.params.artifact_paths).toBeUndefined();
    expect(e2e?.params.run_path).toBeUndefined();

    // A grounded critic (code_critic, full_context: true default) leads its prompt with a
    // description of the inlined <tenet_run_context> block — auto-compiled REFERENCE, not
    // instructions — so it verifies against the docs instead of pattern-matching them onto the
    // output and marking pass. An ungrounded critic (no block) gets no such description.
    expect(codeCritic?.params.prompt).toContain('## Run Context (auto-compiled reference)');
    expect(codeCritic?.params.prompt).toContain('AUTO-COMPILED REFERENCE');
    expect(e2e?.params.prompt).not.toContain('## Run Context (auto-compiled reference)');
  });

  it('does not propagate artifact_paths/run_path to a full_context:false critic (ungrounded review)', async () => {
    const { store, handler } = createHarness();
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: true },
        { id: 'adversarial', prompt_file: '.tenet/critics/adversarial.md', full_context: false },
      ],
    });
    writeCriticPrompt(store, 'adversarial.md', '# Adversarial Critic\n\nReview the diff independently, without the spec.');

    const runPath = '.tenet/runs/2026-07-02-adversarial';
    const sourceId = createSourceJob(store, 'adversarial', {
      run_path: runPath,
      artifact_paths: { spec: `${runPath}/spec.md`, harness: `${runPath}/harness.md` },
    });

    const parsed = parseResult(await handler({ job_id: sourceId, output: { done: true } }));
    const adversarial = store.getJob(jobId(parsed, 'adversarial'));
    const codeCritic = store.getJob(jobId(parsed, 'code_critic'));

    // Ungrounded critic: no inlined run docs — it reviews independently of the spec.
    expect(adversarial?.params.artifact_paths).toBeUndefined();
    expect(adversarial?.params.run_path).toBeUndefined();
    // Grounded built-in still gets them.
    expect(codeCritic?.params.artifact_paths).toEqual({
      spec: `${runPath}/spec.md`,
      harness: `${runPath}/harness.md`,
    });
    expect(codeCritic?.params.run_path).toBe(runPath);

    // Grounded critic leads with the run-context description; the ungrounded custom critic does not.
    expect(codeCritic?.params.prompt).toContain('## Run Context (auto-compiled reference)');
    expect(adversarial?.params.prompt).not.toContain('## Run Context (auto-compiled reference)');
  });
});

describe('tenet_start_eval configurable critic roster', () => {
  it('falls back to the 3 built-in critics when no roster file exists', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(3);
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'interaction_e2e']);
    // expected_eval_stages is stamped on every dispatched critic
    expect(store.getJob(jobId(parsed, 'code_critic'))?.params.expected_eval_stages).toEqual([
      'code_critic',
      'test_critic',
      'interaction_e2e',
    ]);

    await waitForAll(manager, parsed);
  });

  it('falls back to the 3 built-ins and warns when the roster is invalid JSON', async () => {
    const { store, manager, handler } = createHarness();
    writeRoster(store, '{ not valid json');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(3);
    expect(parsed.roster_warning).toEqual(expect.stringContaining('Could not parse'));
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'interaction_e2e']);

    await waitForAll(manager, parsed);
  });

  it('skips a disabled built-in and shrinks expected_eval_stages', async () => {
    const { store, manager, handler } = createHarness();
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: false },
      ],
    });
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(2);
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic']);
    expect(store.getJob(jobId(parsed, 'code_critic'))?.params.expected_eval_stages).toEqual([
      'code_critic',
      'test_critic',
    ]);

    await waitForAll(manager, parsed);
  });

  it('dispatches a custom critic from a prompt file', async () => {
    const { store, manager, handler } = createHarness();
    writeCriticPrompt(
      store,
      'security.md',
      '## Security Critic\n\nReview the diff for injection, secret exposure, and auth gaps.\n\nEnd with: {"passed": true/false, "stage": "security_critic", "findings": [{"category": "product_bug", "detail": "..."}]}',
    );
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: true },
        {
          id: 'security',
          builtin: false,
          enabled: true,
          stage: 'security_critic',
          job_type: 'critic_eval',
          prompt_file: '.tenet/critics/security.md',
        },
      ],
    });
    store.setConfig('eval_parallel_safe:oauth', 'true');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(4);
    expect(jobRoles(parsed)).toContain('security_critic');

    const securityJob = store.getJob(jobId(parsed, 'security_critic'));
    expect(securityJob?.type).toBe('critic_eval');
    const prompt = securityJob?.params.prompt as string;
    expect(prompt).toContain('## Security Critic');
    expect(prompt).toContain('Review the diff for injection');
    // custom critics receive the implementation output section
    expect(prompt).toContain('## Implementation Output');
    // expected_eval_stages includes the custom stage
    expect(securityJob?.params.expected_eval_stages).toEqual([
      'code_critic',
      'test_critic',
      'interaction_e2e',
      'security_critic',
    ]);

    await waitForAll(manager, parsed);
  });

  it('skips a custom critic whose prompt file is missing and reports it', async () => {
    const { store, manager, handler } = createHarness();
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: true },
        {
          id: 'security',
          builtin: false,
          enabled: true,
          stage: 'security_critic',
          job_type: 'critic_eval',
          prompt_file: '.tenet/critics/security.md', // never written
        },
      ],
    });
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(3);
    expect(parsed.skipped_critics).toEqual(['security']);
    expect(jobRoles(parsed)).not.toContain('security_critic');

    await waitForAll(manager, parsed);
  });

  it('chains N critics in roster order when sequential', async () => {
    const { store, manager, handler } = createHarness();
    writeCriticPrompt(store, 'extra.md', '## Extra Critic — reachability.\n');
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true, parallel_safe: false },
        { id: 'test_critic', builtin: true, enabled: true, parallel_safe: false },
        { id: 'interaction_e2e', builtin: true, enabled: true, parallel_safe: false },
        {
          id: 'extra',
          builtin: false,
          enabled: true,
          stage: 'extra_critic',
          job_type: 'critic_eval',
          prompt_file: '.tenet/critics/extra.md',
        },
      ],
    });
    // no eval_parallel_safe verdict + all builtins flagged sequential → full chain
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('sequential');
    const jobs = parsed.jobs as Array<Record<string, unknown>>;
    expect(jobs.map((j) => j.role)).toEqual(['code_critic', 'test_critic', 'interaction_e2e', 'extra_critic']);
    expect(jobs[1].parent_job_id).toBe(jobs[0].job_id);
    expect(jobs[2].parent_job_id).toBe(jobs[1].job_id);
    expect(jobs[3].parent_job_id).toBe(jobs[2].job_id);

    await waitForAll(manager, parsed);
  });
});

describe('tenet_start_eval per-job critic applicability (applicable_jobs)', () => {
  /** Roster: two list-less critics, one matching the source dag_id, one for F2 only. */
  const writeApplicabilityRoster = (store: StateStore): void => {
    writeCriticPrompt(store, 'migration.md', '## Migration Critic\n\nReview alembic migrations only.\n');
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true }, // list-less → every job
        { id: 'test_critic', builtin: true, enabled: true, applicable_jobs: ['job-1'] },
        { id: 'interaction_e2e', builtin: true, enabled: true }, // list-less → every job
        {
          id: 'migration',
          builtin: false,
          enabled: true,
          stage: 'migration_critic',
          prompt_file: '.tenet/critics/migration.md',
          applicable_jobs: ['F2'],
        },
      ],
    });
  };

  it('skips critics whose applicable_jobs does not include the source dag_id', async () => {
    const { store, manager, handler } = createHarness();
    writeApplicabilityRoster(store);
    const sourceId = createSourceJob(store, 'oauth'); // dag_id: 'job-1'

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    // A (test_critic, lists job-1) + both list-less critics dispatch; B (F2-only) skipped.
    expect(parsed.critics_dispatched).toBe(3);
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'interaction_e2e']);
    const skipped = parsed.skipped_inapplicable as Array<{ id: string; reason: string }>;
    expect(skipped).toEqual([{ id: 'migration', reason: expect.stringContaining('F2') }]);

    // expected_eval_stages is stamped from what actually dispatched (the filtered list).
    expect(store.getJob(jobId(parsed, 'code_critic'))?.params.expected_eval_stages).toEqual([
      'code_critic',
      'test_critic',
      'interaction_e2e',
    ]);

    await waitForAll(manager, parsed);
  });

  it('dispatches the full roster for an ad-hoc source job (no dag_id) — fail-safe', async () => {
    const { store, manager, handler } = createHarness();
    writeApplicabilityRoster(store);
    const sourceId = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'adhoc', prompt: 'ad-hoc hotfix', feature: 'oauth' },
      retryCount: 0,
      maxRetries: 3,
    }).id;

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    // Non-applicability can't be proven off-DAG — everything runs.
    expect(parsed.critics_dispatched).toBe(4);
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'interaction_e2e', 'migration_critic']);
    expect(parsed.skipped_inapplicable).toBeUndefined();

    await waitForAll(manager, parsed);
  });

  it('warns (non-fatal) when applicable_jobs references a dag_id no registered job carries', async () => {
    const { store, manager, handler } = createHarness();
    writeCriticPrompt(store, 'migration.md', '## Migration Critic\n\nReview alembic migrations only.\n');
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: true },
        {
          id: 'migration',
          builtin: false,
          enabled: true,
          stage: 'migration_critic',
          prompt_file: '.tenet/critics/migration.md',
          applicable_jobs: ['job-1', 'GONE'],
        },
      ],
    });
    const sourceId = createSourceJob(store, 'oauth'); // dag_id 'job-1' — the only registered one

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    // The critic still dispatched (its list includes the source dag_id) — the
    // stale reference is a warning, never fatal.
    expect(parsed.critics_dispatched).toBe(4);
    const warnings = parsed.stale_dag_id_warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('GONE');

    await waitForAll(manager, parsed);
  });

  it('dispatches every critic when no entry declares applicable_jobs (backwards compat)', async () => {
    const { store, manager, handler } = createHarness();
    writeCriticPrompt(store, 'security.md', '## Security Critic\n\nReview the diff.\n');
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: true },
        { id: 'security', builtin: false, enabled: true, stage: 'security_critic', prompt_file: '.tenet/critics/security.md' },
      ],
    });
    const sourceId = createSourceJob(store, 'oauth'); // dag_id present, but no entry declares a list

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    expect(parsed.critics_dispatched).toBe(4);
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'interaction_e2e', 'security_critic']);
    expect(parsed.skipped_inapplicable).toBeUndefined();
    expect(parsed.stale_dag_id_warnings).toBeUndefined();

    await waitForAll(manager, parsed);
  });
});

describe('tenet_start_eval shared evidence ledger', () => {
  /** Extracts the backticked ledger path out of a critic prompt. */
  const ledgerPathOf = (prompt: string): string => {
    const match = prompt.match(/`([^`]*critics\/evidence\/eval-[^`]*)`/);
    if (!match) {
      throw new Error('no ledger path found in prompt');
    }
    return match[1];
  };

  const createRunSourceJob = (store: StateStore): string =>
    createSourceJob(store, 'oauth', {
      run_path: '.tenet/runs/2026-10-19-oauth',
      run_slug: '2026-10-19-oauth',
    });

  it('bakes the Shared Evidence Ledger block with one shared per-round path into every critic prompt and creates the evidence dir', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createRunSourceJob(store);

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    const ledgerPaths = new Set<string>();
    for (const role of ['code_critic', 'test_critic', 'interaction_e2e'] as const) {
      const prompt = store.getJob(jobId(parsed, role))?.params.prompt as string;
      expect(prompt).toContain('## Shared Evidence Ledger');
      ledgerPaths.add(ledgerPathOf(prompt));
    }
    // One eval_round per dispatch → one ledger path shared by every critic in the round.
    expect(ledgerPaths.size).toBe(1);
    const [ledgerPath] = [...ledgerPaths];
    expect(ledgerPath.startsWith(`.tenet/runs/2026-10-19-oauth/critics/evidence/eval-${sourceId}-`)).toBe(true);
    expect(ledgerPath.endsWith('.jsonl')).toBe(true);

    // The evidence directory exists after dispatch, so critics can append frictionlessly.
    expect(fs.existsSync(path.join(store.projectPath, '.tenet/runs/2026-10-19-oauth/critics/evidence'))).toBe(true);

    await waitForAll(manager, parsed);
  });

  it('gives each dispatch a fresh ledger path (fresh eval_round)', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createRunSourceJob(store);

    const first = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));
    const second = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    const firstPath = ledgerPathOf(store.getJob(jobId(first, 'code_critic'))?.params.prompt as string);
    const secondPath = ledgerPathOf(store.getJob(jobId(second, 'code_critic'))?.params.prompt as string);
    expect(secondPath).not.toBe(firstPath);
    expect(secondPath.startsWith(`.tenet/runs/2026-10-19-oauth/critics/evidence/eval-${sourceId}-`)).toBe(true);

    await waitForAll(manager, first);
    await waitForAll(manager, second);
  });

  it('omits the ledger block when the source job has no run_path (ad-hoc jobs)', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth'); // no run_path

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    for (const role of ['code_critic', 'test_critic', 'interaction_e2e'] as const) {
      const prompt = store.getJob(jobId(parsed, role))?.params.prompt as string;
      expect(prompt).not.toContain('## Shared Evidence Ledger');
    }

    await waitForAll(manager, parsed);
  });

  it('blocks custom critics too — grounded and ungrounded — without displacing their output-contract line', async () => {
    const { store, manager, handler } = createHarness();
    writeCriticPrompt(
      store,
      'security.md',
      '## Security Critic\n\nReview the diff.\n\nEnd with: {"passed": true/false, "stage": "security_critic", "findings": []}',
    );
    writeCriticPrompt(
      store,
      'adversarial.md',
      '## Adversarial Critic\n\nReview from the code alone.\n\nEnd with: {"passed": true/false, "stage": "adversarial_critic", "findings": []}',
    );
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'interaction_e2e', builtin: true, enabled: true },
        {
          id: 'security',
          builtin: false,
          enabled: true,
          stage: 'security_critic',
          job_type: 'critic_eval',
          prompt_file: '.tenet/critics/security.md',
        },
        {
          id: 'adversarial',
          builtin: false,
          enabled: true,
          stage: 'adversarial_critic',
          job_type: 'critic_eval',
          prompt_file: '.tenet/critics/adversarial.md',
          full_context: false,
        },
      ],
    });
    const sourceId = createRunSourceJob(store);

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    // Both grounding modes receive the block — the ledger is context-independent.
    for (const [role, bodyHeading] of [
      ['security_critic', '## Security Critic'],
      ['adversarial_critic', '## Adversarial Critic'],
    ] as const) {
      const prompt = store.getJob(jobId(parsed, role))?.params.prompt as string;
      expect(prompt).toContain('## Shared Evidence Ledger');
      // Procedural scaffolding sits between the job scope and the critic's own mission text.
      expect(prompt.indexOf('## Job Scope')).toBeLessThan(prompt.indexOf('## Shared Evidence Ledger'));
      expect(prompt.indexOf('## Shared Evidence Ledger')).toBeLessThan(prompt.indexOf(bodyHeading));
      // The critic's output-contract line stays inside its body, before the implementation output.
      expect(prompt.indexOf('End with:')).toBeGreaterThan(prompt.indexOf('## Shared Evidence Ledger'));
      expect(prompt.indexOf('End with:')).toBeLessThan(prompt.indexOf('## Implementation Output'));
    }

    await waitForAll(manager, parsed);
  });

  it('embeds the commit SHA from the worker output as the staleness anchor', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createRunSourceJob(store);
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok', commit_sha: sha } }));

    const prompt = store.getJob(jobId(parsed, 'code_critic'))?.params.prompt as string;
    expect(prompt).toContain(`(\`${sha}\`)`);
    // Without a SHA in the output, the staleness rule still reads coherently.
    const noSha = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));
    const noShaPrompt = store.getJob(jobId(noSha, 'code_critic'))?.params.prompt as string;
    expect(noShaPrompt).toContain("the commit this job's output describes");
    expect(noShaPrompt).not.toContain(`(\`${sha}\`)`);

    await waitForAll(manager, parsed);
    await waitForAll(manager, noSha);
  });

  it('keeps every critic end-shape byte-identical to pre-ledger prompts — e2e contract line stays terminal', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createRunSourceJob(store);

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    const e2ePrompt = store.getJob(jobId(parsed, 'interaction_e2e'))?.params.prompt as string;
    const lastLine = e2ePrompt.split('\n').filter((l) => l.trim().length > 0).pop() as string;
    expect(lastLine).toContain('End with: {"passed": true/false, "stage": "interaction_e2e"');
    // Built-in readers keep Worker Output terminal; no ledger text after it.
    const codePrompt = store.getJob(jobId(parsed, 'code_critic'))?.params.prompt as string;
    expect(codePrompt.indexOf('## Shared Evidence Ledger')).toBeLessThan(codePrompt.indexOf('## Code Critic'));

    await waitForAll(manager, parsed);
  });

  it('degrades to no block when the evidence dir cannot be created', async () => {
    const { store, manager, handler } = createHarness();
    // .tenet/runs/2026-10-19-oauth exists as a FILE → mkdir of .../critics/evidence throws ENOTDIR.
    fs.mkdirSync(path.join(store.projectPath, '.tenet', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(store.projectPath, '.tenet', 'runs', '2026-10-19-oauth'), 'not a dir');
    const sourceId = createRunSourceJob(store);

    const parsed = parseResult(await handler({ job_id: sourceId, output: { summary: 'ok' } }));

    const prompt = store.getJob(jobId(parsed, 'code_critic'))?.params.prompt as string;
    expect(prompt).not.toContain('## Shared Evidence Ledger');

    await waitForAll(manager, parsed);
  });
});
