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
  it('opens with the orchestrator role-preamble and never carries worker-bound report-only scope', async () => {
    const { store, handler } = createHarness();
    writeFile(store.projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Spec');
    writeFile(store.projectPath, '.tenet/harness/current.md', '# Harness');
    writeFile(store.projectPath, '.tenet/decomposition/2026-04-16-oauth.md', '# Decomposition');

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: {
        feature: 'oauth',
        name: 'final-report',
        prompt: 'verify',
        report_only: true,
      },
      retryCount: 0,
      maxRetries: 0,
    });

    const parsed = parseResult(await handler({ job_id: job.id }));

    // Orchestrator discipline is re-asserted at the very top of the compiled context.
    expect(parsed.context.startsWith('# Compiled Context (orchestrator aid)')).toBe(true);
    expect(parsed.context).toContain('You are the orchestrator, not the worker');
    expect(parsed.context).toContain('tenet_start_job');
    // The Report-Only Scope block is worker-bound and lives in the dispatch path, not here.
    expect(parsed.context).not.toContain('## Report-Only Scope');
  });

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

  it('inlines project docs and lists run-local evidence without inlining archive contents', async () => {
    const { store, handler } = createHarness();
    const runPath = '.tenet/runs/2026-06-12-oauth';
    writeFile(store.projectPath, '.tenet/project/overview.md', '# Overview Doctrine');
    writeFile(store.projectPath, '.tenet/project/architecture.md', '# Architecture Doctrine');
    writeFile(store.projectPath, '.tenet/project/product.md', '# Product Doctrine');
    writeFile(store.projectPath, '.tenet/project/testing.md', '# Testing Doctrine');
    writeFile(store.projectPath, '.tenet/project/design.md', '# Design Doctrine');
    writeFile(store.projectPath, '.tenet/project/design-components/button.html', '<button>Accepted</button>');
    writeFile(store.projectPath, '.tenet/knowledge/worker-queue.md', '# Worker Queue');
    writeFile(store.projectPath, `${runPath}/spec.md`, '# Run Spec');
    writeFile(store.projectPath, `${runPath}/harness.md`, '# Run Harness');
    writeFile(store.projectPath, `${runPath}/scenarios.md`, '# Run Scenarios');
    writeFile(store.projectPath, `${runPath}/interview.md`, '# Run Interview');
    writeFile(store.projectPath, `${runPath}/decomposition.md`, '# Run Decomposition');
    writeFile(store.projectPath, `${runPath}/journal/attempt-1.md`, '# Attempt 1 should not inline');
    writeFile(store.projectPath, `${runPath}/research/oauth.md`, '# OAuth research should not inline');
    writeFile(store.projectPath, `${runPath}/visuals/mockup.html`, '<html>visual should not inline</html>');
    writeFile(store.projectPath, '.tenet/archive/legacy-v1/spec/old.md', '# Archived Old Spec');
    writeFile(store.projectPath, '.tenet/status/status.md', '# Generated Status');

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: {
        feature: 'oauth',
        run_slug: '2026-06-12-oauth',
        run_path: runPath,
        name: 'build oauth',
        prompt: 'build it',
        artifact_paths: {
          spec: `${runPath}/spec.md`,
          harness: `${runPath}/harness.md`,
          scenarios: `${runPath}/scenarios.md`,
          interview: `${runPath}/interview.md`,
          decomposition: `${runPath}/decomposition.md`,
        },
      },
      retryCount: 0,
      maxRetries: 0,
    });

    const parsed = parseResult(await handler({ job_id: job.id }));

    expect(parsed.context).toContain('# Overview Doctrine');
    expect(parsed.context).toContain('# Architecture Doctrine');
    expect(parsed.context).toContain('# Product Doctrine');
    expect(parsed.context).toContain('# Testing Doctrine');
    expect(parsed.context).toContain('# Design Doctrine');
    expect(parsed.context).toContain('# Run Spec');
    expect(parsed.context).toContain('# Run Harness');
    expect(parsed.context).toContain('# Run Scenarios');
    expect(parsed.context).toContain('# Run Interview');
    expect(parsed.context).toContain('# Run Decomposition');
    expect(parsed.context).toContain('- .tenet/knowledge/worker-queue.md');
    expect(parsed.context).toContain('- .tenet/project/design-components/button.html');
    expect(parsed.context).toContain('- .tenet/runs/2026-06-12-oauth/journal/attempt-1.md');
    expect(parsed.context).toContain('- .tenet/runs/2026-06-12-oauth/research/oauth.md');
    expect(parsed.context).toContain('- .tenet/runs/2026-06-12-oauth/visuals/mockup.html');
    expect(parsed.context).toContain('Archived legacy Tenet evidence exists');
    expect(parsed.context).not.toContain('Attempt 1 should not inline');
    expect(parsed.context).not.toContain('OAuth research should not inline');
    expect(parsed.context).not.toContain('visual should not inline');
    expect(parsed.context).not.toContain('# Archived Old Spec');
    expect(parsed.context).not.toContain('# Generated Status');
  });

  it('still supports legacy feature fallback with a compatibility notice', async () => {
    const { store, handler } = createHarness();
    writeFile(store.projectPath, '.tenet/spec/2026-04-16-oauth.md', '# Legacy Spec');
    writeFile(store.projectPath, '.tenet/spec/scenarios-2026-04-16-oauth.md', '# Legacy Scenarios');
    writeFile(store.projectPath, '.tenet/interview/2026-04-16-oauth.md', '# Legacy Interview');
    writeFile(store.projectPath, '.tenet/decomposition/2026-04-16-oauth.md', '# Legacy Decomposition');
    writeFile(store.projectPath, '.tenet/harness/current.md', '# Legacy Harness');

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: {
        feature: 'oauth',
        name: 'build oauth',
        prompt: 'build it',
      },
      retryCount: 0,
      maxRetries: 0,
    });

    const parsed = parseResult(await handler({ job_id: job.id }));

    expect(parsed.context).toContain('# Legacy Spec');
    expect(parsed.context).toContain('# Legacy Harness');
    expect(parsed.context).toContain('# Legacy Scenarios');
    expect(parsed.context).toContain('# Legacy Interview');
    expect(parsed.context).toContain('# Legacy Decomposition');
    expect(parsed.context).toContain('Compatibility Notice');
  });
});
