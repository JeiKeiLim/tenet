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
  it('runs critics sequentially when eval_parallel_safe verdict is missing', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(false);
    expect(parsed.execution_mode).toBe('sequential');
    expect(parsed.critics_dispatched).toBe(3);

    const codeCriticId = jobId(parsed, 'code_critic');
    const testCriticId = jobId(parsed, 'test_critic');
    const playwrightId = jobId(parsed, 'playwright_eval');

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
    const playwright = store.getJob(jobId(parsed, 'playwright_eval'));

    expect(codeCritic?.status).toBe('running');
    expect(testCritic?.status).toBe('running');
    expect(playwright?.status).toBe('running');
    expect(testCritic?.parentJobId).toBeUndefined();
    expect(playwright?.parentJobId).toBeUndefined();

    await waitForAll(manager, parsed);
  });

  it('runs sequentially when verdict is explicitly false', async () => {
    const { store, manager, handler } = createHarness();
    store.setConfig('eval_parallel_safe:oauth', 'false');
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.eval_parallel_safe).toBe(false);
    expect(parsed.execution_mode).toBe('sequential');

    await waitForAll(manager, parsed);
  });

  it('auto-dispatches the next critic when parent completes', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    const codeCriticId = jobId(parsed, 'code_critic');
    const testCriticId = jobId(parsed, 'test_critic');
    const playwrightId = jobId(parsed, 'playwright_eval');

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
    const playwright = store.getJob(jobId(parsed, 'playwright_eval'));
    const prompt = playwright?.params.prompt as string;

    expect(prompt).toContain('Use exact artifact_paths when provided');
    expect(prompt).toContain('.tenet/project/testing.md');
    expect(prompt).toContain('.tenet/project/design.md');
    expect(prompt).not.toContain('.tenet/harness/current.md');

    await waitForAll(manager, parsed);
  });
});

describe('tenet_start_eval configurable critic roster', () => {
  it('falls back to the 3 built-in critics when no roster file exists', async () => {
    const { store, manager, handler } = createHarness();
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.critics_dispatched).toBe(3);
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);
    // expected_eval_stages is stamped on every dispatched critic
    expect(store.getJob(jobId(parsed, 'code_critic'))?.params.expected_eval_stages).toEqual([
      'code_critic',
      'test_critic',
      'playwright_eval',
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
    expect(jobRoles(parsed)).toEqual(['code_critic', 'test_critic', 'playwright_eval']);

    await waitForAll(manager, parsed);
  });

  it('skips a disabled built-in and shrinks expected_eval_stages', async () => {
    const { store, manager, handler } = createHarness();
    writeRoster(store, {
      version: 1,
      critics: [
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'playwright_eval', builtin: true, enabled: false },
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
        { id: 'playwright_eval', builtin: true, enabled: true },
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
      'playwright_eval',
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
        { id: 'playwright_eval', builtin: true, enabled: true },
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
        { id: 'code_critic', builtin: true, enabled: true },
        { id: 'test_critic', builtin: true, enabled: true },
        { id: 'playwright_eval', builtin: true, enabled: true },
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
    // no eval_parallel_safe verdict → sequential
    const sourceId = createSourceJob(store, 'oauth');

    const result = await handler({ job_id: sourceId, output: { summary: 'ok' } });
    const parsed = parseResult(result);

    expect(parsed.execution_mode).toBe('sequential');
    const jobs = parsed.jobs as Array<Record<string, unknown>>;
    expect(jobs.map((j) => j.role)).toEqual(['code_critic', 'test_critic', 'playwright_eval', 'extra_critic']);
    expect(jobs[1].parent_job_id).toBe(jobs[0].job_id);
    expect(jobs[2].parent_job_id).toBe(jobs[1].job_id);
    expect(jobs[3].parent_job_id).toBe(jobs[2].job_id);

    await waitForAll(manager, parsed);
  });
});
