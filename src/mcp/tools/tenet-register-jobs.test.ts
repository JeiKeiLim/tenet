import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { UNLIMITED_RETRIES } from '../../core/runtime-config.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetRegisterJobsTool } from './tenet-register-jobs.js';

type Handler = (args: {
  feature: string;
  run_slug?: string;
  run_path?: string;
  artifact_paths?: {
    spec?: string;
    harness?: string;
    scenarios?: string | null;
    interview?: string | null;
    decomposition?: string | null;
  };
  jobs: Array<{
    id: string;
    name: string;
    type?: 'dev' | 'integration_test';
    depends_on?: string[];
    prompt: string;
    report_only?: boolean;
    allow_project_doctrine_edits?: boolean;
  }>;
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-register-jobs-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetRegisterJobsTool(registerTool, store);
  if (!captured) throw new Error('handler not captured');

  return { store, handler: captured };
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text) as Record<string, unknown>;
};

const writeFile = (projectPath: string, relPath: string, content: string): void => {
  const fullPath = path.join(projectPath, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_register_jobs', () => {
  it('preserves zero as an explicit no-retry budget', async () => {
    const { store, handler } = createHarness();
    store.setConfig('max_retries', '0');

    const result = await handler({
      feature: 'zero-retry',
      jobs: [{ id: 'job-1', name: 'job one', prompt: 'do it', depends_on: [] }],
    });

    const parsed = parseResult(result);
    const jobs = parsed.jobs as Array<{ db_id: string }>;
    expect(store.getJob(jobs[0].db_id)?.maxRetries).toBe(0);
  });

  it('defaults registered jobs to unlimited retries', async () => {
    const { store, handler } = createHarness();

    const result = await handler({
      feature: 'unlimited-retry',
      jobs: [{ id: 'job-1', name: 'job one', prompt: 'do it', depends_on: [] }],
    });

    const parsed = parseResult(result);
    const jobs = parsed.jobs as Array<{ db_id: string }>;
    expect(store.getJob(jobs[0].db_id)?.maxRetries).toBe(UNLIMITED_RETRIES);
  });

  it('stores explicit artifact paths on every registered job', async () => {
    const { store, handler } = createHarness();
    writeFile(store.projectPath, '.tenet/spec/current.md', '# Spec');
    writeFile(store.projectPath, '.tenet/harness/current.md', '# Harness');
    writeFile(store.projectPath, '.tenet/spec/scenarios-current.md', '# Scenarios');
    writeFile(store.projectPath, '.tenet/interview/current.md', '# Interview');
    writeFile(store.projectPath, '.tenet/decomposition/current.md', '# Decomposition');

    const result = await handler({
      feature: 'artifact-flow',
      artifact_paths: {
        spec: '.tenet/spec/current.md',
        harness: '.tenet/harness/current.md',
        scenarios: '.tenet/spec/scenarios-current.md',
        interview: '.tenet/interview/current.md',
        decomposition: '.tenet/decomposition/current.md',
      },
      jobs: [
        { id: 'job-1', name: 'job one', prompt: 'do it', depends_on: [] },
        { id: 'job-2', name: 'job two', prompt: 'do next', depends_on: ['job-1'] },
      ],
    });

    const parsed = parseResult(result);
    const jobs = parsed.jobs as Array<{ db_id: string }>;
    const expected = {
      spec: '.tenet/spec/current.md',
      harness: '.tenet/harness/current.md',
      scenarios: '.tenet/spec/scenarios-current.md',
      interview: '.tenet/interview/current.md',
      decomposition: '.tenet/decomposition/current.md',
    };

    expect(parsed.warning).toBeUndefined();
    expect(parsed.artifact_paths).toEqual(expected);
    expect(store.getJob(jobs[0].db_id)?.params.artifact_paths).toEqual(expected);
    expect(store.getJob(jobs[1].db_id)?.params.artifact_paths).toEqual(expected);
  });

  it('stores run identity and normalized run path on every registered job', async () => {
    const { store, handler } = createHarness();
    writeFile(store.projectPath, '.tenet/runs/2026-06-12-oauth/spec.md', '# Spec');
    writeFile(store.projectPath, '.tenet/runs/2026-06-12-oauth/harness.md', '# Harness');
    writeFile(store.projectPath, '.tenet/runs/2026-06-12-oauth/scenarios.md', '# Scenarios');
    writeFile(store.projectPath, '.tenet/runs/2026-06-12-oauth/interview.md', '# Interview');
    writeFile(store.projectPath, '.tenet/runs/2026-06-12-oauth/decomposition.md', '# Decomposition');

    const result = await handler({
      feature: 'oauth',
      run_slug: '2026-06-12-oauth',
      run_path: path.join(store.projectPath, '.tenet', 'runs', '2026-06-12-oauth'),
      artifact_paths: {
        spec: '.tenet/runs/2026-06-12-oauth/spec.md',
        harness: '.tenet/runs/2026-06-12-oauth/harness.md',
        scenarios: '.tenet/runs/2026-06-12-oauth/scenarios.md',
        interview: '.tenet/runs/2026-06-12-oauth/interview.md',
        decomposition: '.tenet/runs/2026-06-12-oauth/decomposition.md',
      },
      jobs: [
        {
          id: 'job-1',
          name: 'job one',
          prompt: 'do it',
          depends_on: [],
          allow_project_doctrine_edits: true,
        },
        { id: 'job-2', name: 'job two', prompt: 'do next', depends_on: ['job-1'] },
      ],
    });

    const parsed = parseResult(result);
    const jobs = parsed.jobs as Array<{ db_id: string }>;

    expect(parsed.run_slug).toBe('2026-06-12-oauth');
    expect(parsed.run_path).toBe('.tenet/runs/2026-06-12-oauth');
    expect(parsed.run_path_warning).toBeUndefined();
    expect(store.getJob(jobs[0].db_id)?.params.run_slug).toBe('2026-06-12-oauth');
    expect(store.getJob(jobs[0].db_id)?.params.run_path).toBe('.tenet/runs/2026-06-12-oauth');
    expect(store.getJob(jobs[0].db_id)?.params.allow_project_doctrine_edits).toBe(true);
    expect(store.getJob(jobs[1].db_id)?.params.run_slug).toBe('2026-06-12-oauth');
    expect(store.getJob(jobs[1].db_id)?.params.run_path).toBe('.tenet/runs/2026-06-12-oauth');
  });

  it('rejects run_path outside the project', async () => {
    const { handler } = createHarness();

    await expect(
      handler({
        feature: 'outside',
        run_slug: '2026-06-12-outside',
        run_path: path.join(os.tmpdir(), 'tenet-outside-run'),
        jobs: [{ id: 'job-1', name: 'job one', prompt: 'do it', depends_on: [] }],
      }),
    ).rejects.toThrow(/run_path path must be inside the project/);
  });

  it('warns when run_path is inside the project but outside .tenet/runs', async () => {
    const { handler } = createHarness();

    const result = await handler({
      feature: 'compat',
      run_slug: 'compat-run',
      run_path: '.tenet/custom-run',
      jobs: [{ id: 'job-1', name: 'job one', prompt: 'do it', depends_on: [] }],
    });

    const parsed = parseResult(result);
    expect(parsed.run_path).toBe('.tenet/custom-run');
    expect(parsed.run_path_warning).toContain('outside .tenet/runs/');
    expect(parsed.warning).toContain('artifact_paths was not provided');
  });

  it('warns when registering jobs without artifact paths', async () => {
    const { handler } = createHarness();

    const result = await handler({
      feature: 'fallback',
      jobs: [{ id: 'job-1', name: 'job one', prompt: 'do it', depends_on: [] }],
    });

    const parsed = parseResult(result);
    expect(parsed.warning).toContain('artifact_paths was not provided');
  });
});
