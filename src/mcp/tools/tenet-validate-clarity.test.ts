import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetValidateClarityTool } from './tenet-validate-clarity.js';

class MockAdapter implements AgentAdapter {
  public readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResponse> {
    return { success: true, output: `ok:${invocation.prompt.slice(0, 32)}`, durationMs: 0 };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

type CapturedHandler = (args: { feature?: string }) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): {
  store: StateStore;
  manager: JobManager;
  projectPath: string;
  handler: CapturedHandler;
} => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-clarity-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);
  store.setConfig('agent_override_eval', 'mock-adapter');

  const registry = new AdapterRegistry();
  registry.register(new MockAdapter('mock-adapter'));

  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: 100,
    defaultJobTimeoutMs: 2_000,
    maxParallelAgents: 2,
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

  return { store, manager, projectPath: tempDir, handler: captured };
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
