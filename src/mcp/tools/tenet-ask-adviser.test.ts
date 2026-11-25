import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager, jobManagerConfigForLiveReads } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetJobResultTool } from './tenet-job-result.js';
import { registerTenetAskAdviserTool } from './tenet-ask-adviser.js';
import { jobTypeSchema, parseJobType, type RegisterTool } from './utils.js';

/**
 * TASK-058: tenet_ask_adviser dispatch contract.
 *
 * Non-spawning doubles only: the adviser path is exercised with an inline
 * MockAdapter, so no real agent CLI is ever launched. The AC #7 tests in the
 * last describe block are deliberately written against a real
 * `.tenet/.state/config.json` file + the live reader both server entry points
 * install (jobManagerConfigForLiveReads). Seeding via `stateStore.setConfig`
 * would pass while production is broken — agent config never lives in the
 * SQLite config table.
 */

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  public calls = 0;
  public lastInvocation?: AgentInvocation;
  private readonly output: string;

  constructor(name: string, output = 'ok') {
    this.name = name;
    this.output = output;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    this.calls += 1;
    this.lastInvocation = invocation;
    return { success: true, output: this.output, durationMs: 0 };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type AdviserHandler = (args: {
  question: string;
  source_job_ids?: string[];
  context_pointers?: string[];
}) => Promise<CallToolResult>;

type JobResultHandler = (args: { job_id: string }) => Promise<CallToolResult>;

type Harness = {
  projectPath: string;
  store: StateStore;
  manager: JobManager;
  adviserAdapter: MockAdapter;
  workerAdapter: MockAdapter;
  askAdviser: AdviserHandler;
  jobResult: JobResultHandler;
};

type HarnessOptions = {
  /**
   * Written to .tenet/.state/config.json; the JobManager reads it through the
   * live reader both server entry points install (jobManagerConfigForLiveReads).
   * When set, the adviser/defaultAgent/defaultAgentModel options are ignored —
   * the file is the single source of truth, exactly as in production.
   */
  configFile?: Record<string, unknown>;
  /** Adviser pair — also written to the raw config as adviser_agent/adviser_model. */
  adviser?: { agent: string; model: string };
  /** Written to the raw config as default_agent. */
  defaultAgent?: string;
  /** Written to the raw config as default_agent_model. */
  defaultAgentModel?: string;
  adviserOutput?: string;
};

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (options: HarnessOptions = {}): Harness => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-ask-adviser-test-'));
  tempDirs.push(projectPath);

  if (options.configFile) {
    const stateDir = path.join(projectPath, '.tenet', '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(options.configFile));
  }

  const store = new StateStore(projectPath);
  stores.push(store);

  const adviserAgent = options.adviser?.agent ?? 'claude-code';
  const adviserAdapter = new MockAdapter(
    adviserAgent,
    options.adviserOutput ?? '## RECOMMENDATION\n\nUse option 4: check frozen tests A2/A7.',
  );
  const workerAdapter = new MockAdapter('mock-worker');

  const registry = new AdapterRegistry();
  registry.register(adviserAdapter);
  registry.register(workerAdapter);

  const rawConfig: Record<string, unknown> = {
    ...(options.defaultAgent ? { default_agent: options.defaultAgent } : {}),
    ...(options.defaultAgentModel ? { default_agent_model: options.defaultAgentModel } : {}),
    ...(options.adviser ? { adviser_agent: options.adviser.agent, adviser_model: options.adviser.model } : {}),
  };
  const manager = new JobManager(
    store,
    registry,
    options.configFile
      ? jobManagerConfigForLiveReads(projectPath, 'ask-adviser-test-server')
      : {
          heartbeatTimeoutMs: 1_000,
          defaultJobTimeoutMs: 2_000,
          readStateConfig: () => rawConfig,
        },
  );

  const handlers = new Map<string, (args: never) => Promise<CallToolResult>>();
  const registerTool = ((name: string, _def: unknown, handler: (args: never) => Promise<CallToolResult>) => {
    handlers.set(name, handler);
  }) as unknown as RegisterTool;

  registerTenetAskAdviserTool(registerTool, manager, store);
  registerTenetJobResultTool(registerTool, manager);

  const askAdviser = handlers.get('tenet_ask_adviser') as unknown as AdviserHandler;
  const jobResult = handlers.get('tenet_job_result') as unknown as JobResultHandler;
  if (!askAdviser || !jobResult) throw new Error('handler not captured');

  return { projectPath, store, manager, adviserAdapter, workerAdapter, askAdviser, jobResult };
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text);
};

const createSourceJob = (
  store: StateStore,
  overrides: {
    name?: string;
    runPath?: string;
    artifactPaths?: Record<string, string>;
  } = {},
) => {
  const runPath = overrides.runPath ?? '.tenet/runs/2026-11-16-adviser-run';
  const artifactPaths = overrides.artifactPaths ?? {
    spec: `${runPath}/spec.md`,
    harness: `${runPath}/harness.md`,
    scenarios: `${runPath}/scenarios.md`,
    decomposition: `${runPath}/decomposition.md`,
    interview: `${runPath}/interview.md`,
  };

  return store.createJob({
    type: 'dev',
    status: 'completed',
    params: {
      name: overrides.name ?? 'implement-act-registration',
      prompt: 'implement the feature',
      run_path: runPath,
      artifact_paths: artifactPaths,
      feature: 'adviser-demo',
    },
    retryCount: 0,
    maxRetries: 3,
  });
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_ask_adviser configured dispatch', () => {
  it('dispatches an adviser job on the configured agent with the pinned model', async () => {
    const harness = createHarness({
      // A non-default adviser agent proves the dispatch uses adviser_agent, not default_agent.
      adviser: { agent: 'codex', model: 'gpt-6-astra' },
      defaultAgent: 'mock-worker',
    });
    const source = createSourceJob(harness.store);
    const question =
      'J04 is blocked on version selection. The worker offers options A and B, but both look wrong. What should we do?';

    const result = await harness.askAdviser({ question, source_job_ids: [source.id] });
    const parsed = parseResult(result);

    // Response shape: the standard startJobResponse (wait, then collect).
    expect(parsed.job_type).toBe('adviser');
    expect(parsed.status).toBe('running');
    expect(parsed.next_tool).toBe('tenet_job_wait');
    expect(parsed.next_args).toEqual({ job_id: parsed.job_id, wait_seconds: 30 });
    expect(parsed.message).toContain('Job dispatched');

    const adviserJob = harness.store.getJob(parsed.job_id as string);
    if (!adviserJob) throw new Error('adviser job not persisted');
    expect(adviserJob.type).toBe('adviser');
    expect(adviserJob.agentName).toBe('codex');
    expect(adviserJob.params.question).toBe(question);
    expect(adviserJob.params.source_job_ids).toEqual([source.id]);
    expect(adviserJob.params.run_path).toBe(source.params.run_path);
    expect(adviserJob.params.artifact_paths).toEqual(source.params.artifact_paths);

    const waited = await harness.manager.waitForJob(adviserJob.id, null, 5_000);
    expect(waited.status).toBe('completed');
    expect(harness.adviserAdapter.calls).toBe(1);
    expect(harness.workerAdapter.calls).toBe(0);

    const invocation = harness.adviserAdapter.lastInvocation;
    if (!invocation) throw new Error('adviser invocation not captured');

    // The adviser model rides invocation.model — adapters strip any manual --model
    // from *_args and place theirs (codex rejects duplicate model flags).
    expect(invocation.model).toBe('gpt-6-astra');
    expect(invocation.extraArgs).toEqual([]);
    // No worker run-context block: the adviser gets path pointers only.
    expect(invocation.context).toBeUndefined();
    expect(invocation.prompt).not.toContain('<tenet_run_context>');
    expect(invocation.prompt).not.toContain('Deliverable Requirements');
  });

  it('builds the bespoke adviser preamble, the verbatim question, and RUN CONTEXT pointers', async () => {
    const harness = createHarness({
      adviser: { agent: 'claude-code', model: 'opus' },
      defaultAgent: 'mock-worker',
    });
    const runPath = '.tenet/runs/2026-11-16-adviser-run';
    const source = createSourceJob(harness.store, { runPath });
    const question = 'Which option satisfies frozen tests A2 and A7?\nOption 1: register ACT. Option 2: patch fixture.';

    const result = await harness.askAdviser({ question, source_job_ids: [source.id] });
    const parsed = parseResult(result);
    await harness.manager.waitForJob(parsed.job_id as string, null, 5_000);

    const prompt = harness.adviserAdapter.lastInvocation?.prompt ?? '';

    // Contract markers: read-only, full-repo edge, guardrail, dual output contract.
    expect(prompt).toContain('## Adviser — decision-point consultation');
    expect(prompt).toContain('Read-only by instruction');
    expect(prompt).toContain('DO NOT modify files');
    expect(prompt).toContain('Full-repo edge');
    expect(prompt).toContain('Cross-check ALL acceptance and');
    expect(prompt).toContain('Verify every worker-cited claim');
    expect(prompt).toContain('## RECOMMENDATION');
    expect(prompt).toContain("## GENUINELY USER'S CALL");
    expect(prompt).toContain('file:line evidence');
    expect(prompt).toContain('Be decisive and cite evidence');

    // The composed question is carried verbatim.
    expect(prompt).toContain(question);
    expect(prompt).toContain('## Escalation Question');

    // RUN CONTEXT is paths only, resolved from the source job's stored artifact_paths.
    expect(prompt).toContain('## Run Context (paths only — read these files from the repo)');
    expect(prompt).toContain(`- run dir: ${runPath}`);
    expect(prompt).toContain(`- spec: ${runPath}/spec.md`);
    expect(prompt).toContain(`- harness: ${runPath}/harness.md`);
    expect(prompt).toContain(`- scenarios: ${runPath}/scenarios.md`);
    expect(prompt).toContain(`- decomposition: ${runPath}/decomposition.md`);
    // The five documented lines: interview is not one of them and nothing is inlined.
    expect(prompt).not.toContain(`- interview: ${runPath}/interview.md`);
    expect(prompt).not.toContain('# Worker Spec');
  });

  it('resolves RUN CONTEXT from the first source_job_ids entry', async () => {
    const harness = createHarness({
      adviser: { agent: 'claude-code', model: 'opus' },
      defaultAgent: 'mock-worker',
    });
    const first = createSourceJob(harness.store, {
      name: 'first-anchor',
      runPath: '.tenet/runs/2026-11-16-first',
    });
    const second = createSourceJob(harness.store, {
      name: 'second-anchor',
      runPath: '.tenet/runs/2026-11-16-second',
    });

    const result = await harness.askAdviser({
      question: 'Two parallel failures share one root cause; what is it?',
      source_job_ids: [first.id, second.id],
    });
    const parsed = parseResult(result);
    const adviserJob = harness.store.getJob(parsed.job_id as string);
    expect(adviserJob?.params.source_job_ids).toEqual([first.id, second.id]);

    await harness.manager.waitForJob(parsed.job_id as string, null, 5_000);
    const prompt = harness.adviserAdapter.lastInvocation?.prompt ?? '';
    expect(prompt).toContain('- run dir: .tenet/runs/2026-11-16-first');
    expect(prompt).not.toContain('.tenet/runs/2026-11-16-second');
  });

  it('uses explicit context_pointers when there is no source job anchor', async () => {
    const harness = createHarness({
      adviser: { agent: 'claude-code', model: 'opus' },
      defaultAgent: 'mock-worker',
    });
    const pointers = [
      '.tenet/runs/2026-11-16-adviser-run/spec.md',
      '.tenet/runs/2026-11-16-adviser-run/harness.md',
    ];

    const result = await harness.askAdviser({
      question: 'No job anchor — which frozen test wins the contradiction?',
      context_pointers: pointers,
    });
    const parsed = parseResult(result);
    const adviserJob = harness.store.getJob(parsed.job_id as string);
    expect(adviserJob?.params.context_pointers).toEqual(pointers);
    expect(adviserJob?.params.run_path).toBeUndefined();

    await harness.manager.waitForJob(parsed.job_id as string, null, 5_000);
    const prompt = harness.adviserAdapter.lastInvocation?.prompt ?? '';
    expect(prompt).toContain('## Run Context (paths only — read these files from the repo)');
    for (const pointer of pointers) {
      expect(prompt).toContain(pointer);
    }
  });

  it('falls back to context_pointers when the anchor job resolves no run paths', async () => {
    const harness = createHarness({
      adviser: { agent: 'claude-code', model: 'opus' },
      defaultAgent: 'mock-worker',
    });
    // Pathless ad-hoc job: an anchor that resolves zero RUN CONTEXT lines.
    const anchor = harness.store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'ad-hoc', prompt: 'do something' },
      retryCount: 0,
      maxRetries: 3,
    });
    const pointers = ['.tenet/runs/2026-11-16-adviser-run/spec.md'];

    const result = await harness.askAdviser({
      question: 'The anchor has no stored paths — use the explicit pointers.',
      source_job_ids: [anchor.id],
      context_pointers: pointers,
    });
    const parsed = parseResult(result);

    await harness.manager.waitForJob(parsed.job_id as string, null, 5_000);
    const prompt = harness.adviserAdapter.lastInvocation?.prompt ?? '';
    expect(prompt).toContain('## Run Context (paths only — read these files from the repo)');
    expect(prompt).toContain(pointers[0]);
  });

  it('throws a tool error when a source_job_ids anchor does not exist', async () => {
    const harness = createHarness({
      adviser: { agent: 'claude-code', model: 'opus' },
      defaultAgent: 'mock-worker',
    });

    await expect(
      harness.askAdviser({
        question: 'anchor is missing',
        source_job_ids: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).rejects.toThrow(/source job not found/);

    // The failure happens before dispatch: no adviser job was created.
    expect(harness.store.getJobsByStatus('running')).toHaveLength(0);
    expect(harness.store.getJobsByStatus('pending')).toHaveLength(0);
  });
});

describe('tenet_ask_adviser unset-config no-op', () => {
  it('returns adviser_configured:false with ask-the-user guidance and creates no job', async () => {
    const harness = createHarness({ defaultAgent: 'mock-worker' });

    const result = await harness.askAdviser({ question: 'Should we pick A or B?' });
    const parsed = parseResult(result);

    expect(parsed.adviser_configured).toBe(false);
    expect(parsed.message).toContain('Surface this question to the user');
    expect(parsed.how_to_configure).toContain('tenet config --adviser-agent');
    expect(parsed.note).toContain('both adviser_agent and adviser_model');

    // Not an error result: the orchestrator must fall back to the user, not crash.
    expect(result.isError).toBeUndefined();
    expect(harness.store.getJobsByStatus('pending')).toHaveLength(0);
    expect(harness.store.getJobsByStatus('running')).toHaveLength(0);
    expect(harness.adviserAdapter.calls).toBe(0);
  });

});

describe('tenet_ask_adviser answer-return path', () => {
  it('returns the adviser output through tenet_job_result like any worker report', async () => {
    const adviserOutput =
      '## RECOMMENDATION\n\nOption 4: update the fixture loader, not the test.\nEvidence: tests/acceptance/test_act_registration.py:88.';
    const harness = createHarness({
      adviser: { agent: 'claude-code', model: 'opus' },
      defaultAgent: 'mock-worker',
      adviserOutput,
    });

    const dispatched = await harness.askAdviser({ question: 'version selection ambiguity' });
    const jobId = parseResult(dispatched).job_id as string;

    const waited = await harness.manager.waitForJob(jobId, null, 5_000);
    expect(waited.is_terminal).toBe(true);
    expect(waited.status).toBe('completed');

    const resultPayload = parseResult(await harness.jobResult({ job_id: jobId }));
    expect(resultPayload.status).toBe('completed');
    expect(resultPayload.error).toBeUndefined();
    const output = resultPayload.output as { adapter: string; output: string };
    expect(output.adapter).toBe('claude-code');
    expect(output.output).toBe(adviserOutput);
  });
});

describe('adviser config reaches the tool via the live config file (AC #7)', () => {
  it('reads adviser_agent/adviser_model from .tenet/.state/config.json, not StateStore config', async () => {
    const configFile = {
      default_agent: 'mock-worker',
      default_agent_model: 'sonnet',
      adviser_agent: 'claude-code',
      adviser_model: 'opus[1m]',
    };

    // Exactly what src/mcp/index.ts / src/cli/serve.ts install: the live reader
    // over the raw JSON file, read per dispatch.
    const harness = createHarness({
      configFile,
    });

    // The trap this test pins: agent config never lives in the SQLite config
    // table — the file's keys never sync into it, and a bogus DB row cannot
    // steer dispatch toward a different agent.
    expect(harness.store.getConfig('adviser_agent')).toBeNull();
    expect(harness.store.getConfig('adviser_model')).toBeNull();
    harness.store.setConfig('adviser_agent', 'bogus-agent');
    harness.store.setConfig('default_agent', 'bogus-worker');
    expect(harness.manager.isAdviserConfigured()).toBe(true);

    const result = await harness.askAdviser({ question: 'Which option satisfies the frozen tests?' });
    const parsed = parseResult(result);
    expect(parsed.adviser_configured).toBeUndefined(); // configured dispatch, not the no-op payload
    expect(parsed.job_type).toBe('adviser');

    await harness.manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(harness.adviserAdapter.lastInvocation?.model).toBe('opus[1m]');
  });

  it('injects default_agent_model for jobs on the default agent only', async () => {
    const configFile = {
      default_agent: 'mock-worker',
      default_agent_model: 'sonnet',
      adviser_agent: 'claude-code',
      adviser_model: 'opus[1m]',
    };
    const harness = createHarness({ configFile });
    // A bogus DB default_agent must be ignored — the file resolves the agent.
    harness.store.setConfig('default_agent', 'bogus-worker');

    const workerJob = harness.manager.startJob('dev', { name: 'plain-worker', prompt: 'implement' });
    await harness.manager.waitForJob(workerJob.id, null, 5_000);
    expect(harness.workerAdapter.lastInvocation?.model).toBe('sonnet');
  });

  it('a partial adviser pair in config.json yields the not-configured no-op', async () => {
    const configFile = {
      default_agent: 'mock-worker',
      adviser_agent: 'claude-code',
    };
    const harness = createHarness({ configFile });

    expect(harness.manager.isAdviserConfigured()).toBe(false);
    const result = await harness.askAdviser({ question: 'partial config must not dispatch' });
    expect(parseResult(result).adviser_configured).toBe(false);
    expect(harness.adviserAdapter.calls).toBe(0);
    expect(harness.store.getJobsByStatus('running')).toHaveLength(0);
  });

  it('picks up an adviser config edit between calls with no restart (live config)', async () => {
    const configFile = { default_agent: 'mock-worker', adviser_agent: 'claude-code', adviser_model: 'opus[1m]' };
    const harness = createHarness({ configFile });
    const question = 'Which option satisfies the frozen tests?';

    const first = parseResult(await harness.askAdviser({ question }));
    expect(first.adviser_configured).toBeUndefined();
    await harness.manager.waitForJob(first.job_id as string, null, 5_000);
    expect(harness.adviserAdapter.lastInvocation?.model).toBe('opus[1m]');

    // A CLI edit clears the adviser pair mid-session: the NEXT call sees it —
    // no restart.
    const stateDir = path.join(harness.projectPath, '.tenet', '.state');
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      default_agent: 'mock-worker',
    }), 'utf8');

    const second = parseResult(await harness.askAdviser({ question }));
    expect(second.adviser_configured).toBe(false);
    expect(second.message).toContain('No adviser is configured');
    expect(harness.store.getJobsByStatus('running')).toHaveLength(0);
  });
});

describe('adviser JobType enumeration surfaces', () => {
  it('jobTypeSchema accepts adviser and the previously missing integration_test', () => {
    // AC #6: the Zod enum is one of three enumeration surfaces; it had pre-existing
    // drift omitting integration_test, which is fixed alongside the adviser addition.
    expect(jobTypeSchema.safeParse('adviser').success).toBe(true);
    expect(jobTypeSchema.safeParse('integration_test').success).toBe(true);
    expect(parseJobType('adviser')).toBe('adviser');
  });
});
