import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { StateStore } from '../../core/state-store.js';
import { registerTenetCompileContextTool } from './tenet-compile-context.js';

type Handler = (args: { job_id: string }) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-compile-context-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetCompileContextTool(registerTool, store);
  if (!captured) throw new Error('handler not captured');

  return { store, handler: captured };
};

const writeFile = (projectPath: string, relPath: string, content: string): void => {
  const fullPath = path.join(projectPath, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
};

const parseResult = (result: CallToolResult): { context: string } => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text) as { context: string };
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_compile_context artifact paths', () => {
  it('reads exact artifact paths stored on the job instead of feature fallback files', async () => {
    const { store, handler } = createHarness();
    writeFile(store.projectPath, '.tenet/spec/custom-current.md', '# Current Spec');
    writeFile(store.projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Stale Spec');
    writeFile(store.projectPath, '.tenet/spec/scenarios-custom.md', '# Current Scenarios');
    writeFile(store.projectPath, '.tenet/spec/scenarios-2026-04-16-oauth.md', '# Stale Scenarios');
    writeFile(store.projectPath, '.tenet/interview/custom.md', '# Current Interview');
    writeFile(store.projectPath, '.tenet/interview/2026-04-16-oauth.md', '# Stale Interview');
    writeFile(store.projectPath, '.tenet/decomposition/custom.md', '# Current Decomposition');
    writeFile(store.projectPath, '.tenet/decomposition/2026-04-16-oauth.md', '# Stale Decomposition');
    writeFile(store.projectPath, '.tenet/harness/custom.md', '# Current Harness');
    writeFile(store.projectPath, '.tenet/harness/current.md', '# Stale Harness');

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: {
        feature: 'oauth',
        name: 'build oauth',
        prompt: 'build it',
        artifact_paths: {
          spec: '.tenet/spec/custom-current.md',
          harness: '.tenet/harness/custom.md',
          scenarios: '.tenet/spec/scenarios-custom.md',
          interview: '.tenet/interview/custom.md',
          decomposition: '.tenet/decomposition/custom.md',
        },
      },
      retryCount: 0,
      maxRetries: 0,
    });

    const parsed = parseResult(await handler({ job_id: job.id }));

    expect(parsed.context).toContain('# Current Spec');
    expect(parsed.context).toContain('# Current Harness');
    expect(parsed.context).toContain('# Current Scenarios');
    expect(parsed.context).toContain('# Current Interview');
    expect(parsed.context).toContain('# Current Decomposition');
    expect(parsed.context).not.toContain('# Stale Spec');
    expect(parsed.context).not.toContain('# Stale Harness');
    expect(parsed.context).not.toContain('# Stale Scenarios');
    expect(parsed.context).not.toContain('# Stale Interview');
    expect(parsed.context).not.toContain('# Stale Decomposition');
  });

  it('rejects missing exact artifact paths instead of silently falling back', async () => {
    const { store, handler } = createHarness();
    writeFile(store.projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Fallback Spec');
    writeFile(store.projectPath, '.tenet/harness/current.md', '# Fallback Harness');

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: {
        feature: 'oauth',
        name: 'build oauth',
        prompt: 'build it',
        artifact_paths: {
          spec: '.tenet/spec/missing-current.md',
          harness: '.tenet/harness/current.md',
        },
      },
      retryCount: 0,
      maxRetries: 0,
    });

    await expect(handler({ job_id: job.id })).rejects.toThrow(/artifact_paths\.spec not found/);
  });
});
