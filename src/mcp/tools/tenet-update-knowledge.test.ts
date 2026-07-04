import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { StateStore } from '../../core/state-store.js';
import { registerTenetUpdateKnowledgeTool } from './tenet-update-knowledge.js';

type Handler = (args: {
  title: string;
  job_id: string;
  findings: Record<string, unknown>;
  type?: 'knowledge' | 'journal';
  confidence?: 'implemented-and-tested' | 'implemented-not-tested' | 'decision-only' | 'scanned-not-verified';
}) => Promise<CallToolResult>;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createHarness = (): { store: StateStore; handler: Handler } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-update-knowledge-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);

  let captured: Handler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: Handler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetUpdateKnowledgeTool(registerTool, store);
  if (!captured) throw new Error('handler not captured');

  return { store, handler: captured };
};

const parseResult = (result: CallToolResult): { file: string; filename: string } => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text) as { file: string; filename: string };
};

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_update_knowledge', () => {
  it('writes reusable knowledge to top-level .tenet/knowledge', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'source job', run_path: '.tenet/runs/2026-06-12-oauth' },
      retryCount: 0,
      maxRetries: 0,
    });

    const result = parseResult(await handler({
      title: 'Worker Queue',
      job_id: job.id,
      type: 'knowledge',
      confidence: 'implemented-and-tested',
      findings: { summary: 'queue facts' },
    }));

    expect(result.file).toMatch(/^\.tenet\/knowledge\/\d{4}-\d{2}-\d{2}_worker-queue\.md$/);
    expect(result.filename).toMatch(/worker-queue\.md$/);
    const content = fs.readFileSync(path.join(store.projectPath, result.file), 'utf8');
    expect(content).toContain('type: knowledge');
    expect(content).toContain('confidence: implemented-and-tested');
  });

  it('writes journal entries to the source job run journal when run_path exists', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: {
        name: 'source job',
        run_path: '.tenet/runs/2026-06-12-oauth',
      },
      retryCount: 0,
      maxRetries: 0,
    });

    const result = parseResult(await handler({
      title: 'Job Finished',
      job_id: job.id,
      type: 'journal',
      findings: { summary: 'done' },
    }));

    expect(result.file).toMatch(/^\.tenet\/runs\/2026-06-12-oauth\/journal\/\d{4}-\d{2}-\d{2}_job-finished\.md$/);
    const content = fs.readFileSync(path.join(store.projectPath, result.file), 'utf8');
    expect(content).toContain('type: journal');
    expect(content).toContain(`source_job: ${job.id}`);
  });

  it('routes a journal entry through source_job_id ancestry when the named job lacks run_path', async () => {
    const { store, handler } = createHarness();
    // The source dev job carries the run_path.
    const sourceJob = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'source job', run_path: '.tenet/runs/2026-06-12-oauth' },
      retryCount: 0,
      maxRetries: 0,
    });
    // The named job is an ungrounded critic: source_job_id → the dev job, but no run_path of its
    // own (tenet_start_eval only propagates run_path to grounded critics). The entry must still
    // land in the source job's run journal, not the top-level .tenet/journal/.
    const criticJob = store.createJob({
      type: 'critic_eval',
      status: 'completed',
      params: { name: 'code critic', source_job_id: sourceJob.id },
      retryCount: 0,
      maxRetries: 0,
    });

    const result = parseResult(await handler({
      title: 'Critic Note',
      job_id: criticJob.id,
      type: 'journal',
      findings: { summary: 'via ancestry' },
    }));

    expect(result.file).toMatch(/^\.tenet\/runs\/2026-06-12-oauth\/journal\/\d{4}-\d{2}-\d{2}_critic-note\.md$/);
    const content = fs.readFileSync(path.join(store.projectPath, result.file), 'utf8');
    expect(content).toContain(`source_job: ${criticJob.id}`);
  });

  it('routes through parent_job_id ancestry when source_job_id is absent', async () => {
    const { store, handler } = createHarness();
    const parentJob = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'parent', run_path: '.tenet/runs/2026-06-12-oauth' },
      retryCount: 0,
      maxRetries: 0,
    });
    const childJob = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'child' },
      retryCount: 0,
      maxRetries: 0,
      parentJobId: parentJob.id,
    });

    const result = parseResult(await handler({
      title: 'Child Note',
      job_id: childJob.id,
      type: 'journal',
      findings: { summary: 'via parent' },
    }));

    expect(result.file).toMatch(/^\.tenet\/runs\/2026-06-12-oauth\/journal\/\d{4}-\d{2}-\d{2}_child-note\.md$/);
  });

  it('keeps legacy journal routing for jobs without run_path', async () => {
    const { store, handler } = createHarness();
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'legacy job' },
      retryCount: 0,
      maxRetries: 0,
    });

    const result = parseResult(await handler({
      title: 'Legacy Journal',
      job_id: job.id,
      type: 'journal',
      findings: { summary: 'legacy' },
    }));

    expect(result.file).toMatch(/^\.tenet\/journal\/\d{4}-\d{2}-\d{2}_legacy-journal\.md$/);
    expect(fs.existsSync(path.join(store.projectPath, result.file))).toBe(true);
  });

  it('handles unknown job ids consistently by writing a legacy journal entry', async () => {
    const { store, handler } = createHarness();
    const result = parseResult(await handler({
      title: 'Unknown Job',
      job_id: '00000000-0000-4000-8000-000000000000',
      type: 'journal',
      findings: { summary: 'unknown' },
    }));

    expect(result.file).toMatch(/^\.tenet\/journal\/\d{4}-\d{2}-\d{2}_unknown-job\.md$/);
    const content = fs.readFileSync(path.join(store.projectPath, result.file), 'utf8');
    expect(content).toContain('job_name: unknown');
  });
});
