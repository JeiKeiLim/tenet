import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager, jobManagerConfigFromStateConfig } from '../../core/job-manager.js';
import type { GateValidatorsConfig } from '../../core/runtime-config.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetValidateReadinessTool } from './tenet-validate-readiness.js';

class MockAdapter implements AgentAdapter {
  public readonly name: string;
  public calls = 0;
  public lastInvocation?: AgentInvocation;

  constructor(name: string) {
    this.name = name;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    this.calls += 1;
    this.lastInvocation = invocation;
    return { success: true, output: `ok:${invocation.prompt.slice(0, 32)}`, durationMs: 0 };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type ArtifactPaths = {
  spec?: string;
  harness?: string;
  scenarios?: string | null;
  interview?: string | null;
};

type CapturedHandlerArgs = { feature: string; artifact_paths?: ArtifactPaths };
type ReadinessHandler = (args: CapturedHandlerArgs) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

type HarnessOptions = {
  /** JobManager config spread, as both server entry points derive it via jobManagerConfigFromStateConfig. */
  managerConfig?: {
    adviser?: { agent: string; model: string };
    defaultAgentModel?: string;
    gateValidators?: GateValidatorsConfig;
    serverId?: string;
  };
  /** Extra adapter names to register beyond the default mock-adapter. */
  extraAdapters?: string[];
  /** Written to .tenet/.state/config.json before StateStore starts (server-startup shape). */
  configFile?: Record<string, unknown>;
};

const createHarness = (
  options: HarnessOptions = {},
): {
  store: StateStore;
  manager: JobManager;
  projectPath: string;
  handler: ReadinessHandler;
  adapters: Map<string, MockAdapter>;
} => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-readiness-test-'));
  tempDirs.push(tempDir);

  if (options.configFile) {
    const stateDir = path.join(tempDir, '.tenet', '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(options.configFile));
  }

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_eval', 'mock-adapter');

  const registry = new AdapterRegistry();
  const adapters = new Map<string, MockAdapter>();
  for (const name of ['mock-adapter', ...(options.extraAdapters ?? [])]) {
    const adapter = new MockAdapter(name);
    adapters.set(name, adapter);
    registry.register(adapter);
  }

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 100,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 2,
    ...(options.managerConfig ?? {}),
  });

  let captured: ReadinessHandler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: ReadinessHandler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetValidateReadinessTool(registerTool, manager, store);

  if (!captured) {
    throw new Error('handler not captured');
  }

  return { store, manager, projectPath: tempDir, handler: captured, adapters };
};

const writeFile = (projectPath: string, relPath: string, content: string): void => {
  const fullPath = path.join(projectPath, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') {
    throw new Error('expected text content');
  }
  return JSON.parse(first.text);
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

describe('tenet_validate_readiness', () => {
  it('throws when spec file is missing', async () => {
    const { handler, projectPath } = createHarness();
    writeFile(projectPath, '.tenet/harness/current.md', '# harness');

    await expect(handler({ feature: 'oauth' })).rejects.toThrow(/Spec not found/);
  });

  it('throws when harness file is missing', async () => {
    const { handler, projectPath } = createHarness();
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# spec');

    await expect(handler({ feature: 'oauth' })).rejects.toThrow(/Harness not found/);
  });

  it('dispatches an eval job with feature-scoped prompt when files exist', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Spec body for oauth');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness body');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);

    expect(typeof parsed.job_id).toBe('string');

    const job = store.getJob(parsed.job_id as string);
    expect(job).toBeTruthy();
    expect(job?.type).toBe('eval');
    expect(job?.params.eval_type).toBe('readiness_validation');
    expect(job?.params.feature).toBe('oauth');

    const prompt = job?.params.prompt as string;
    expect(prompt).toContain('IMPLEMENTATION READINESS');
    expect(prompt).toContain('# Feature: oauth');
    expect(prompt).toContain('Spec body for oauth');
    expect(prompt).toContain('Harness body');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('resolves the latest dated spec file for the feature', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/spec/2026-04-10-oauth.md', '# Older spec');
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Newer spec');
    writeFile(projectPath, '.tenet/spec/2026-04-15-payments.md', '# Unrelated');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(prompt).toContain('Newer spec');
    expect(prompt).not.toContain('Older spec');
    expect(prompt).not.toContain('Unrelated');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('rubric prompt includes the eval parallel safety question and output fields', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Spec');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(prompt).toContain('Eval Execution Mode');
    expect(prompt).toContain('eval_parallel_safe');
    expect(prompt).toContain('eval_parallel_rationale');
    expect(prompt).toContain('share mutable state');
    expect(prompt).toContain('Hard gates before scoring');
    expect(prompt).toContain('Delivery Mode Decision');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('blocks agile specs missing the Slice plan section before dispatch', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/spec/2026-04-16-oauth.md',
      ['---', 'delivery_mode: agile', '---', '', '# Spec'].join('\n'),
    );
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const output = manager.getJobResult(parsed.job_id as string).output as {
      passed: boolean;
      blockers: string[];
    };

    expect(job?.status).toBe('completed');
    expect(output.passed).toBe(false);
    expect(output.blockers.join('\n')).toContain('missing ## Slice plan');
  });

  it('blocks Full-mode readiness when the interview lacks a delivery mode decision', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/spec/2026-04-16-oauth.md',
      ['---', 'delivery_mode: autonomous', '---', '', '# Spec'].join('\n'),
    );
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');
    writeFile(
      projectPath,
      '.tenet/interview/2026-04-16-oauth.md',
      ['# Interview: OAuth', '', 'Date: 2026-04-16', 'Mode: Full'].join('\n'),
    );

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const output = manager.getJobResult(parsed.job_id as string).output as {
      passed: boolean;
      blockers: string[];
    };

    expect(job?.status).toBe('completed');
    expect(output.passed).toBe(false);
    expect(output.blockers.join('\n')).toContain('Delivery Mode Decision');
  });

  it('blocks Full-mode readiness when spec delivery mode mismatches the interview decision', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/spec/2026-04-16-oauth.md',
      [
        '---',
        'delivery_mode: agile',
        '---',
        '',
        '# Spec',
        '',
        '## Slice plan',
        '',
        '### Slice 1: Base',
      ].join('\n'),
    );
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');
    writeFile(
      projectPath,
      '.tenet/interview/2026-04-16-oauth.md',
      [
        '# Interview: OAuth',
        '',
        'Date: 2026-04-16',
        'Mode: Full',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: autonomous',
        '- Selected delivery_mode: autonomous',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const output = manager.getJobResult(parsed.job_id as string).output as {
      passed: boolean;
      blockers: string[];
    };

    expect(job?.status).toBe('completed');
    expect(output.passed).toBe(false);
    expect(output.blockers.join('\n')).toContain('does not match interview');
  });

  it('includes optional scenarios and interview when present', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Spec');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');
    writeFile(projectPath, '.tenet/spec/scenarios-2026-04-16-oauth.md', '# Scenario body');
    writeFile(projectPath, '.tenet/interview/2026-04-16-oauth.md', '# Interview body');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(prompt.indexOf('## Spec')).toBeLessThan(prompt.indexOf('# Spec'));
    expect(prompt.indexOf('# Spec')).toBeLessThan(prompt.indexOf('## Harness'));
    expect(prompt).toContain('Scenario body');
    expect(prompt).toContain('Interview body');
    expect(prompt).toContain('do not re-score clarity');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('uses explicit artifact paths for nonstandard current-run filenames', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/spec/current-oauth-plan.md', '# Explicit current spec');
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Stale dated spec');
    writeFile(projectPath, '.tenet/spec/scenarios-custom-oauth.md', '# Explicit scenarios');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    const result = await handler({
      feature: 'oauth',
      artifact_paths: {
        spec: '.tenet/spec/current-oauth-plan.md',
        harness: '.tenet/harness/current.md',
        scenarios: '.tenet/spec/scenarios-custom-oauth.md',
        interview: null,
      },
    });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(parsed.warning).toBeUndefined();
    expect(parsed.artifact_paths).toEqual({
      spec: '.tenet/spec/current-oauth-plan.md',
      harness: '.tenet/harness/current.md',
      scenarios: '.tenet/spec/scenarios-custom-oauth.md',
      interview: null,
    });
    expect(job?.params.artifact_paths).toEqual(parsed.artifact_paths);
    expect(prompt).toContain('Explicit current spec');
    expect(prompt).toContain('Explicit scenarios');
    expect(prompt).not.toContain('Stale dated spec');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('accepts exact run-local artifact paths', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/spec.md', '# Run Spec');
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/harness.md', '# Run Harness');
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/scenarios.md', '# Run Scenarios');
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/interview.md', '# Run Interview');
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Stale legacy spec');

    const result = await handler({
      feature: 'oauth',
      artifact_paths: {
        spec: '.tenet/runs/2026-06-12-oauth/spec.md',
        harness: '.tenet/runs/2026-06-12-oauth/harness.md',
        scenarios: '.tenet/runs/2026-06-12-oauth/scenarios.md',
        interview: '.tenet/runs/2026-06-12-oauth/interview.md',
      },
    });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(parsed.warning).toBeUndefined();
    expect(parsed.artifact_paths).toEqual({
      spec: '.tenet/runs/2026-06-12-oauth/spec.md',
      harness: '.tenet/runs/2026-06-12-oauth/harness.md',
      scenarios: '.tenet/runs/2026-06-12-oauth/scenarios.md',
      interview: '.tenet/runs/2026-06-12-oauth/interview.md',
    });
    expect(job?.params.artifact_paths).toEqual(parsed.artifact_paths);
    expect(prompt).toContain('Run Spec');
    expect(prompt).toContain('Run Harness');
    expect(prompt).toContain('Run Scenarios');
    expect(prompt).toContain('Run Interview');
    expect(prompt).not.toContain('Stale legacy spec');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('includes run-local artifact paths in deterministic preflight failure jobs', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-oauth/spec.md',
      ['---', 'delivery_mode: agile', '---', '', '# Spec without slice plan'].join('\n'),
    );
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/harness.md', '# Harness');

    const result = await handler({
      feature: 'oauth',
      artifact_paths: {
        spec: '.tenet/runs/2026-06-12-oauth/spec.md',
        harness: '.tenet/runs/2026-06-12-oauth/harness.md',
        scenarios: null,
        interview: null,
      },
    });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const output = manager.getJobResult(parsed.job_id as string).output as {
      passed: boolean;
      blockers: string[];
    };

    expect(job?.status).toBe('completed');
    expect(job?.params.artifact_paths).toEqual({
      spec: '.tenet/runs/2026-06-12-oauth/spec.md',
      harness: '.tenet/runs/2026-06-12-oauth/harness.md',
      scenarios: null,
      interview: null,
    });
    expect(output.passed).toBe(false);
    expect(output.blockers.join('\n')).toContain('missing ## Slice plan');
  });

  it('warns but does not select scenarios as the spec in feature-only fallback', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Real spec');
    writeFile(projectPath, '.tenet/spec/scenarios-2026-04-16-oauth.md', '# Scenario body');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(parsed.warning).toContain('artifact_paths was not provided');
    expect(parsed.artifact_paths).toEqual({
      spec: '.tenet/spec/2026-04-16-oauth.md',
      harness: '.tenet/harness/current.md',
      scenarios: '.tenet/spec/scenarios-2026-04-16-oauth.md',
      interview: null,
    });
    expect(prompt.indexOf('## Spec')).toBeLessThan(prompt.indexOf('# Real spec'));
    expect(prompt.indexOf('# Real spec')).toBeLessThan(prompt.indexOf('## Harness'));
    expect(prompt.indexOf('## Scenarios & Anti-Scenarios')).toBeLessThan(prompt.indexOf('# Scenario body'));

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('accepts quoted YAML delivery_mode in spec front matter', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/spec/2026-04-16-oauth.md',
      ['---', 'delivery_mode: "agile"', '---', '', '# Spec', '', '## Slice plan'].join('\n'),
    );
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');
    writeFile(
      projectPath,
      '.tenet/interview/2026-04-16-oauth.md',
      [
        '# Interview: OAuth',
        '',
        'Date: 2026-04-16',
        'Mode: Full',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: agile',
        '- Selected delivery_mode: agile',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);

    expect(job?.status).toBe('running');
    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('rejects explicit artifact paths outside the project', async () => {
    const { handler, projectPath } = createHarness();
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    await expect(
      handler({
        feature: 'oauth',
        artifact_paths: {
          spec: path.join(os.tmpdir(), 'outside-spec.md'),
          harness: '.tenet/harness/current.md',
          scenarios: null,
          interview: null,
        },
      }),
    ).rejects.toThrow(/must be inside the project/);
  });

  it('blocks decomposition when the spec is a placeholder (deterministic substance gate)', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-oauth/spec.md',
      [
        '---',
        'delivery_mode: autonomous',
        '---',
        '',
        '# OAuth Spec',
        '',
        'TODO: write the actual spec. This is a placeholder — fill in later.',
      ].join('\n'),
    );
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/harness.md', '# Harness');

    const result = await handler({
      feature: 'oauth',
      artifact_paths: {
        spec: '.tenet/runs/2026-06-12-oauth/spec.md',
        harness: '.tenet/runs/2026-06-12-oauth/harness.md',
        scenarios: null,
        interview: null,
      },
    });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const output = manager.getJobResult(parsed.job_id as string).output as {
      passed: boolean;
      blockers: string[];
    };

    // The old gate would have dispatched this to the readiness model; the substance
    // gate now blocks it deterministically before dispatch.
    expect(job?.status).toBe('completed');
    expect(output.passed).toBe(false);
    expect(output.blockers.join('\n')).toMatch(/placeholder/i);
  });

  it('does not block a spec whose TODO lives inside a fenced code sample', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-oauth/spec.md',
      [
        '---',
        'delivery_mode: autonomous',
        '---',
        '',
        '# OAuth Spec',
        '',
        'Users authenticate via OAuth2. A valid token returns 200 and a session cookie.',
        '',
        '```ts',
        '// TODO: implement token exchange',
        'export function exchange(code: string) {}',
        '```',
      ].join('\n'),
    );
    writeFile(projectPath, '.tenet/runs/2026-06-12-oauth/harness.md', '# Harness');

    const result = await handler({
      feature: 'oauth',
      artifact_paths: {
        spec: '.tenet/runs/2026-06-12-oauth/spec.md',
        harness: '.tenet/runs/2026-06-12-oauth/harness.md',
        scenarios: null,
        interview: null,
      },
    });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);

    // No placeholder markers in prose (only inside a code block) → dispatched to the
    // readiness model (rubric embedded in the prompt), not deterministically blocked.
    expect(job?.params.prompt).toContain('IMPLEMENTATION READINESS');
    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });
});

describe('tenet_validate_readiness gate model config', () => {
  const writeDispatchableArtifacts = (projectPath: string): void => {
    writeFile(projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Spec body for oauth');
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness body');
  };

  it('dispatches on the readiness pair and reports the effective agent+model (tier 1)', async () => {
    const { handler, projectPath, store, manager, adapters } = createHarness({
      managerConfig: { gateValidators: { readiness: { agent: 'mock-gate-readiness', model: 'gpt-6-astra' } } },
      extraAdapters: ['mock-gate-readiness'],
    });
    writeDispatchableArtifacts(projectPath);

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);

    expect(parsed.validator_agent).toBe('mock-gate-readiness');
    expect(parsed.validator_model).toBe('gpt-6-astra');
    const job = store.getJob(parsed.job_id as string);
    expect(job?.agentName).toBe('mock-gate-readiness');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    const gate = adapters.get('mock-gate-readiness');
    expect(gate?.calls).toBe(1);
    expect(gate?.lastInvocation?.model).toBe('gpt-6-astra');
    expect(adapters.get('mock-adapter')?.calls).toBe(0);
  });

  it('inherits the clarity pair when readiness is unset (tier 2)', async () => {
    const { handler, projectPath, store, manager, adapters } = createHarness({
      managerConfig: { gateValidators: { clarity: { agent: 'mock-gate-clarity', model: 'opus' } } },
      extraAdapters: ['mock-gate-clarity'],
    });
    writeDispatchableArtifacts(projectPath);

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);

    expect(parsed.validator_agent).toBe('mock-gate-clarity');
    expect(parsed.validator_model).toBe('opus');
    expect(store.getJob(parsed.job_id as string)?.agentName).toBe('mock-gate-clarity');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-clarity')?.lastInvocation?.model).toBe('opus');
  });

  it('reports the default tier when no pair resolves anywhere (tiers 4-5)', async () => {
    const { handler, projectPath, manager, adapters } = createHarness();
    writeDispatchableArtifacts(projectPath);

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);

    // The harness's agent_override_eval='mock-adapter' is the resolved tier-4 agent;
    // no default_agent_model is configured, so the judging model is the CLI default.
    expect(parsed.validator_agent).toBe('mock-adapter');
    expect(parsed.validator_model).toBe('CLI default');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-adapter')?.lastInvocation?.model).toBeUndefined();
  });

  it('reads the gate pair from .tenet/.state/config.json, not StateStore config (server-startup wiring)', async () => {
    // Exactly what src/mcp/index.ts / src/cli/serve.ts do at startup: write the
    // raw JSON file, then derive the JobManager config with the shared helper
    // both entry points consume (jobManagerConfigFromStateConfig).
    const configFile = {
      default_agent: 'mock-adapter',
      readiness_agent: 'mock-gate-readiness',
      readiness_model: 'gpt-6-astra',
    };
    const { handler, projectPath, store, manager, adapters } = createHarness({
      configFile,
      managerConfig: jobManagerConfigFromStateConfig(configFile, 'test-server'),
      extraAdapters: ['mock-gate-readiness'],
    });
    writeDispatchableArtifacts(projectPath);

    // The trap this test pins: StateStore's loadFileConfig whitelist does NOT
    // carry the gate keys, so seeding via setConfig would prove nothing.
    expect(store.getConfig('readiness_agent')).toBeNull();
    expect(store.getConfig('readiness_model')).toBeNull();
    expect(store.getConfig('default_agent')).toBe('mock-adapter');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    expect(parsed.validator_agent).toBe('mock-gate-readiness');
    expect(parsed.validator_model).toBe('gpt-6-astra');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-readiness')?.lastInvocation?.model).toBe('gpt-6-astra');
  });

  it('reports its OWN pair when both gates are configured to distinct pairs (tier-1 reporting)', async () => {
    // With sibling-symmetric configs a swapped getGateDispatchInfo key in the
    // tool resolves to the same pair and passes every other test — only distinct
    // pairs pin that the readiness tool reports the readiness pair.
    const { handler, projectPath, manager, adapters } = createHarness({
      managerConfig: {
        gateValidators: {
          clarity: { agent: 'mock-gate-clarity', model: 'opus' },
          readiness: { agent: 'mock-gate-readiness', model: 'gpt-6-astra' },
        },
      },
      extraAdapters: ['mock-gate-clarity', 'mock-gate-readiness'],
    });
    writeDispatchableArtifacts(projectPath);

    const parsed = parseResult(await handler({ feature: 'oauth' }));
    expect(parsed.validator_agent).toBe('mock-gate-readiness');
    expect(parsed.validator_model).toBe('gpt-6-astra');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-readiness')?.calls).toBe(1);
    expect(adapters.get('mock-gate-clarity')?.calls).toBe(0);
  });

  it('keeps the deterministic preflight response unchanged (no validator fields)', async () => {
    const { handler, projectPath } = createHarness();
    // Agile spec front matter without the Slice plan section: fails before dispatch.
    writeFile(
      projectPath,
      '.tenet/spec/2026-04-16-oauth.md',
      ['---', 'delivery_mode: agile', '---', '', '# Spec'].join('\n'),
    );
    writeFile(projectPath, '.tenet/harness/current.md', '# Harness');

    const result = await handler({ feature: 'oauth' });
    const parsed = parseResult(result);
    expect(parsed.message).toContain('failed before dispatch');
    expect(parsed.validator_agent).toBeUndefined();
    expect(parsed.validator_model).toBeUndefined();
  });
});
