import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAdapter, AgentInvocation, AgentResponse } from '../../adapters/base.js';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetValidateReadinessTool } from './tenet-validate-readiness.js';

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

type CapturedHandler = (args: { feature: string }) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): {
  store: StateStore;
  manager: JobManager;
  projectPath: string;
  handler: CapturedHandler;
} => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-readiness-test-'));
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

  registerTenetValidateReadinessTool(registerTool, manager, store);

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

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
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

    expect(prompt).toContain('Scenario body');
    expect(prompt).toContain('Interview body');
    expect(prompt).toContain('do not re-score clarity');

    await manager.waitForJob(parsed.job_id as string, null, 5_000);
  });
});
