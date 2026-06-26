import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { AdapterRegistry } from '../../adapters/index.js';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import type { Job } from '../../types/index.js';
import { registerTenetGetStatusTool } from './tenet-get-status.js';

type GetStatusHandler = (args: {
  view?: 'summary' | 'queue';
  include_blocked?: boolean;
}) => Promise<CallToolResult>;

const HEARTBEAT_TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];
const stores: StateStore[] = [];
const managers: JobManager[] = [];

interface Harness {
  store: StateStore;
  manager: JobManager;
  handler: GetStatusHandler;
}

const createHarness = (): Harness => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-get-status-test-'));
  tempDirs.push(tempDir);

  const store = new StateStore(tempDir);
  stores.push(store);

  const registry = new AdapterRegistry();
  // Constructed before any jobs exist, so the constructor-time orphan reset
  // runs on an empty store and cannot touch jobs seeded afterwards.
  const manager = new JobManager(store, registry, {
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    defaultJobTimeoutMs: 5_000,
  });
  managers.push(manager);

  let captured: GetStatusHandler | undefined;
  const registerTool = ((_name: string, _def: unknown, handler: GetStatusHandler) => {
    captured = handler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  registerTenetGetStatusTool(registerTool, store, manager);
  if (!captured) throw new Error('handler not captured');

  return { store, manager, handler: captured };
};

const parseResult = (result: CallToolResult): Record<string, unknown> => {
  const first = result.content[0];
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text);
};

const seed = (
  store: StateStore,
  opts: Partial<Omit<Job, 'id' | 'createdAt'>> & Pick<Job, 'type' | 'status' | 'params'>,
): Job => store.createJob({ retryCount: 0, maxRetries: 3, ...opts });

afterEach(() => {
  while (managers.length > 0) managers.pop()?.shutdown();
  while (stores.length > 0) stores.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenet_get_status', () => {
  it('default call (no view) is the unchanged high-level summary — no jobs list', async () => {
    const { store, handler } = createHarness();
    seed(store, { type: 'dev', status: 'pending', params: { name: 'p1', prompt: 'x' } });

    const parsed = parseResult(await handler({}));

    expect(parsed).not.toHaveProperty('jobs');
    expect(parsed).not.toHaveProperty('truncated');
    expect(parsed.jobs_completed).toBe(0);
    expect(parsed.jobs_remaining).toBe(1);
    expect(typeof parsed.last_activity).toBe('string');
  });

  it('view=queue returns pending+running with id/age/stale; pending never stale, heartbeat-stale running flagged', async () => {
    const { store, handler } = createHarness();
    const now = Date.now();
    const pending = seed(store, { type: 'dev', status: 'pending', params: { name: 'p1', prompt: 'x' } });
    const runningFresh = seed(store, {
      type: 'dev',
      status: 'running',
      params: { name: 'r1', prompt: 'x' },
      startedAt: now,
      lastHeartbeat: now,
    });
    const runningStale = seed(store, {
      type: 'dev',
      status: 'running',
      params: { name: 'r2', prompt: 'secret-prompt' },
      startedAt: now - 120_000,
      lastHeartbeat: now - 120_000,
    });

    const parsed = parseResult(await handler({ view: 'queue' }));
    const jobs = parsed.jobs as Array<Record<string, unknown>>;
    const ids = jobs.map((j) => j.id);

    expect(ids).toEqual(expect.arrayContaining([pending.id, runningFresh.id, runningStale.id]));
    expect(jobs).toHaveLength(3);

    const stale = jobs.find((j) => j.id === runningStale.id) as Record<string, unknown>;
    expect(stale.stale).toBe(true);
    expect(stale.stale_reason).toBe('heartbeat_timeout');

    const fresh = jobs.find((j) => j.id === runningFresh.id) as Record<string, unknown>;
    expect(fresh.stale).toBe(false);
    expect(fresh).not.toHaveProperty('stale_reason');

    const p = jobs.find((j) => j.id === pending.id) as Record<string, unknown>;
    expect(p.stale).toBe(false);
    expect(typeof p.age_ms).toBe('number');

    // No params/prompt leaked — only identity + status + age + staleness.
    for (const j of jobs) {
      expect(j).not.toHaveProperty('params');
      expect(JSON.stringify(j)).not.toContain('secret-prompt');
      expect(j.type).toBeDefined();
      expect(j.status).toBeDefined();
      expect(j.name).toBeDefined();
    }
  });

  it('include_blocked=true surfaces blocked and blocked_on_finding jobs (default hides them)', async () => {
    const { store, handler } = createHarness();
    const pending = seed(store, { type: 'dev', status: 'pending', params: { name: 'p1', prompt: 'x' } });
    const blocked = seed(store, { type: 'dev', status: 'blocked', params: { name: 'b1', prompt: 'x' } });
    const bof = seed(store, {
      type: 'dev',
      status: 'blocked_on_finding',
      params: { name: 'bof1', prompt: 'x' },
    });

    const withoutBlocked = parseResult(await handler({ view: 'queue' }));
    const withoutIds = (withoutBlocked.jobs as Array<{ id: string }>).map((j) => j.id);
    expect(withoutIds).toEqual(expect.arrayContaining([pending.id]));
    expect(withoutIds).not.toContain(blocked.id);
    expect(withoutIds).not.toContain(bof.id);

    const withBlocked = parseResult(await handler({ view: 'queue', include_blocked: true }));
    const ids = (withBlocked.jobs as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([pending.id, blocked.id, bof.id]));
  });

  it('caps the queue at 100 rows oldest-first and sets truncated=true', async () => {
    const { store, handler } = createHarness();
    const first = seed(store, { type: 'dev', status: 'pending', params: { name: 'first', prompt: 'x' } });
    const created = [first];
    for (let i = 1; i < 105; i += 1) {
      created.push(seed(store, { type: 'dev', status: 'pending', params: { name: `j${i}`, prompt: 'x' } }));
    }
    const last = created[created.length - 1];

    const parsed = parseResult(await handler({ view: 'queue' }));
    expect(parsed.truncated).toBe(true);
    const jobs = parsed.jobs as Array<{ id: string }>;
    expect(jobs).toHaveLength(100);
    // Oldest retained (first inserted), newest beyond cap dropped (last inserted).
    expect(jobs.some((j) => j.id === first.id)).toBe(true);
    expect(jobs.some((j) => j.id === last.id)).toBe(false);
  });
});
