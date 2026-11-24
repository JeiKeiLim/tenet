import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager, jobManagerConfigFromStateConfig } from '../../core/job-manager.js';
import type { GateValidatorsConfig } from '../../core/runtime-config.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetValidateClarityTool } from './tenet-validate-clarity.js';

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

type CapturedHandler = (args: { feature?: string }) => Promise<CallToolResult>;

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

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (
  options: HarnessOptions = {},
): {
  store: StateStore;
  manager: JobManager;
  projectPath: string;
  handler: CapturedHandler;
  adapters: Map<string, MockAdapter>;
} => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-clarity-test-'));
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

  let captured: CapturedHandler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: CapturedHandler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetValidateClarityTool(registerTool, manager, store);

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

describe('tenet_validate_clarity', () => {
  it('throws when the interview transcript is missing', async () => {
    const { handler } = createHarness();

    await expect(handler({ feature: 'oauth' })).rejects.toThrow(/Interview transcript not found/);
  });

  it('blocks Full-mode transcripts missing the delivery mode decision', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/interview/2026-05-06-tetris.md',
      [
        '# Interview: Tetris',
        '',
        'Date: 2026-05-06',
        'Mode: Full',
        'Rounds: 1',
        '',
        '## Summary',
        'Build a Tetris web game.',
      ].join('\n'),
    );

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const output = manager.getJobResult(parsed.job_id as string).output as {
      passed: boolean;
      gaps: string[];
    };

    expect(job?.status).toBe('completed');
    expect(output.passed).toBe(false);
    expect(output.gaps.join('\n')).toContain('Delivery Mode Decision');
  });

  it('dispatches the rubric when Full-mode delivery mode decision is recorded', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/interview/2026-05-06-tetris.md',
      [
        '# Interview: Tetris',
        '',
        'Date: 2026-05-06',
        'Mode: Full',
        'Rounds: 1',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: agile',
        '- Selected delivery_mode: agile',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(job?.status).toBe('running');
    expect(prompt).toContain('Full-mode Delivery Mode Gate');
    expect(prompt).toContain('Selected delivery_mode: agile');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('prefers run-local interview transcripts over legacy feature transcripts', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/interview/2026-05-06-tetris.md',
      '# Legacy Interview\n\nMode: Full\n',
    );
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-tetris/interview.md',
      [
        '# Interview: Tetris',
        '',
        'Date: 2026-06-12',
        'Mode: Full',
        'Rounds: 1',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: autonomous',
        '- Selected delivery_mode: autonomous',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(job?.status).toBe('running');
    expect(prompt).toContain('Date: 2026-06-12');
    expect(prompt).toContain('Selected delivery_mode: autonomous');
    expect(prompt).not.toContain('# Legacy Interview');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('prefers a feature-matched legacy transcript over a different feature run', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-payments/interview.md',
      [
        '# Interview: Payments',
        '',
        'PAYMENTS-MARKER',
        'Mode: Full',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: autonomous',
        '- Selected delivery_mode: autonomous',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );
    writeFile(
      projectPath,
      '.tenet/interview/2026-05-01-oauth.md',
      [
        '# Interview: Oauth',
        '',
        'OAUTH-MARKER',
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
    const prompt = job?.params.prompt as string;

    expect(prompt).toContain('OAUTH-MARKER');
    expect(prompt).not.toContain('PAYMENTS-MARKER');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });

  it('rejects instead of selecting a different feature run when no feature match exists', async () => {
    const { handler, projectPath } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-payments/interview.md',
      '# Interview: Payments\n\nMode: Full\n',
    );

    await expect(handler({ feature: 'oauth' })).rejects.toThrow(/Interview transcript not found/);
  });

  it('matches run directories by exact feature slug, not suffix', async () => {
    const { handler, projectPath } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-oauth/interview.md',
      '# Interview: Oauth\n\nMode: Full\n',
    );

    // 'auth' must not match a run whose feature slug is 'oauth'.
    await expect(handler({ feature: 'auth' })).rejects.toThrow(/Interview transcript not found/);
  });

  it('uses the latest run interview when feature is omitted', async () => {
    const { handler, projectPath, store, manager } = createHarness();
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-10-foo/interview.md',
      [
        '# Interview: Foo',
        '',
        'FOO-MARKER',
        'Mode: Full',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: autonomous',
        '- Selected delivery_mode: autonomous',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );
    writeFile(
      projectPath,
      '.tenet/runs/2026-06-12-bar/interview.md',
      [
        '# Interview: Bar',
        '',
        'BAR-MARKER',
        'Mode: Full',
        '',
        '## Delivery Mode Decision',
        '- Prompt shown: Choose autonomous or agile.',
        '- User response: autonomous',
        '- Selected delivery_mode: autonomous',
        '- Selection basis: explicit_user_choice',
      ].join('\n'),
    );

    const result = await handler({});
    const parsed = parseResult(result);
    const job = store.getJob(parsed.job_id as string);
    const prompt = job?.params.prompt as string;

    expect(prompt).toContain('BAR-MARKER');
    expect(prompt).not.toContain('FOO-MARKER');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });
});

describe('tenet_validate_clarity gate model config', () => {
  const writeDispatchableTranscript = (projectPath: string): void => {
    writeFile(
      projectPath,
      '.tenet/interview/2026-05-06-tetris.md',
      ['# Interview: Tetris', '', 'Mode: Quick', '', '## Summary', 'Build a Tetris web game.'].join('\n'),
    );
  };

  it('dispatches on the clarity pair and reports the effective agent+model (tier 1)', async () => {
    const { handler, projectPath, store, manager, adapters } = createHarness({
      managerConfig: { gateValidators: { clarity: { agent: 'mock-gate-clarity', model: 'opus' } } },
      extraAdapters: ['mock-gate-clarity'],
    });
    writeDispatchableTranscript(projectPath);

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);

    expect(parsed.validator_agent).toBe('mock-gate-clarity');
    expect(parsed.validator_model).toBe('opus');
    const job = store.getJob(parsed.job_id as string);
    expect(job?.agentName).toBe('mock-gate-clarity');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    const gate = adapters.get('mock-gate-clarity');
    expect(gate?.calls).toBe(1);
    expect(gate?.lastInvocation?.model).toBe('opus');
    expect(adapters.get('mock-adapter')?.calls).toBe(0);
  });

  it('inherits the readiness pair when clarity is unset (tier 2)', async () => {
    const { handler, projectPath, store, manager, adapters } = createHarness({
      managerConfig: { gateValidators: { readiness: { agent: 'mock-gate-readiness', model: 'gpt-6-astra' } } },
      extraAdapters: ['mock-gate-readiness'],
    });
    writeDispatchableTranscript(projectPath);

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);

    expect(parsed.validator_agent).toBe('mock-gate-readiness');
    expect(parsed.validator_model).toBe('gpt-6-astra');
    expect(store.getJob(parsed.job_id as string)?.agentName).toBe('mock-gate-readiness');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-readiness')?.lastInvocation?.model).toBe('gpt-6-astra');
  });

  it('reports the default tier when no pair resolves anywhere (tiers 4-5)', async () => {
    const { handler, projectPath, manager, adapters } = createHarness();
    writeDispatchableTranscript(projectPath);

    const result = await handler({ feature: 'tetris' });
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
      clarity_agent: 'mock-gate-clarity',
      clarity_model: 'opus',
    };
    const { handler, projectPath, store, manager, adapters } = createHarness({
      configFile,
      managerConfig: jobManagerConfigFromStateConfig(configFile, 'test-server'),
      extraAdapters: ['mock-gate-clarity'],
    });
    writeDispatchableTranscript(projectPath);

    // The trap this test pins: StateStore's loadFileConfig whitelist does NOT
    // carry the gate keys, so seeding via setConfig would prove nothing.
    expect(store.getConfig('clarity_agent')).toBeNull();
    expect(store.getConfig('clarity_model')).toBeNull();
    expect(store.getConfig('default_agent')).toBe('mock-adapter');

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);
    expect(parsed.validator_agent).toBe('mock-gate-clarity');
    expect(parsed.validator_model).toBe('opus');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-clarity')?.lastInvocation?.model).toBe('opus');
  });

  it('reports its OWN pair when both gates are configured to distinct pairs (tier-1 reporting)', async () => {
    // With sibling-symmetric configs a swapped getGateDispatchInfo key in the
    // tool resolves to the same pair and passes every other test — only distinct
    // pairs pin that the clarity tool reports the clarity pair, not the sibling's.
    const { handler, projectPath, manager, adapters } = createHarness({
      managerConfig: {
        gateValidators: {
          clarity: { agent: 'mock-gate-clarity', model: 'opus' },
          readiness: { agent: 'mock-gate-readiness', model: 'gpt-6-astra' },
        },
      },
      extraAdapters: ['mock-gate-clarity', 'mock-gate-readiness'],
    });
    writeDispatchableTranscript(projectPath);

    const parsed = parseResult(await handler({ feature: 'tetris' }));
    expect(parsed.validator_agent).toBe('mock-gate-clarity');
    expect(parsed.validator_model).toBe('opus');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-clarity')?.calls).toBe(1);
    expect(adapters.get('mock-gate-readiness')?.calls).toBe(0);
  });

  it('reports the inherited adviser pair in the dispatch response (tier 3)', async () => {
    const { handler, projectPath, manager, adapters } = createHarness({
      managerConfig: { adviser: { agent: 'mock-gate-adviser', model: 'adviser-opus' } },
      extraAdapters: ['mock-gate-adviser'],
    });
    writeDispatchableTranscript(projectPath);

    const parsed = parseResult(await handler({ feature: 'tetris' }));
    expect(parsed.validator_agent).toBe('mock-gate-adviser');
    expect(parsed.validator_model).toBe('adviser-opus');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-gate-adviser')?.lastInvocation?.model).toBe('adviser-opus');
  });

  it('reports the default_agent_model pin at the default tier (tier 4)', async () => {
    const { handler, projectPath, manager, adapters } = createHarness({
      // default_agent synced via the loadFileConfig whitelist; the harness's
      // agent_override_eval resolves the agent and it IS the default agent, so
      // the pin is reported instead of "CLI default".
      configFile: { default_agent: 'mock-adapter' },
      managerConfig: { defaultAgentModel: 'sonnet' },
    });
    writeDispatchableTranscript(projectPath);

    const parsed = parseResult(await handler({ feature: 'tetris' }));
    expect(parsed.validator_agent).toBe('mock-adapter');
    expect(parsed.validator_model).toBe('sonnet');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
    expect(adapters.get('mock-adapter')?.lastInvocation?.model).toBe('sonnet');
  });

  it('keeps the deterministic preflight response unchanged (no validator fields)', async () => {
    const { handler, projectPath } = createHarness();
    // Full-mode transcript without the delivery mode decision: fails before dispatch.
    writeFile(
      projectPath,
      '.tenet/interview/2026-05-06-tetris.md',
      ['# Interview: Tetris', '', 'Mode: Full', '', '## Summary', 'Build a Tetris web game.'].join('\n'),
    );

    const result = await handler({ feature: 'tetris' });
    const parsed = parseResult(result);
    expect(parsed.message).toContain('failed before dispatch');
    expect(parsed.validator_agent).toBeUndefined();
    expect(parsed.validator_model).toBeUndefined();
  });
});
