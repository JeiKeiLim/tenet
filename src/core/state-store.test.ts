import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from './state-store.js';

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createStore = (): { tempDir: string; store: StateStore } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
  const store = new StateStore(tempDir);
  tempDirs.push(tempDir);
  stores.push(store);
  return { tempDir, store };
};

afterEach(() => {
  while (stores.length > 0) {
    const store = stores.pop();
    store?.close();
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('StateStore', () => {
  it('handles job lifecycle create/get/update with status transitions', () => {
    const { store } = createStore();

    const created = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'implement feature' },
      agentName: 'default',
      retryCount: 0,
      maxRetries: 3,
    });

    const loaded = store.getJob(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe('pending');

    const startedAt = Date.now();
    store.updateJob(created.id, {
      status: 'running',
      startedAt,
      lastHeartbeat: startedAt,
    });

    const completedAt = startedAt + 10;
    store.updateJob(created.id, {
      status: 'completed',
      completedAt,
    });

    const updated = store.getJob(created.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.startedAt).toBe(startedAt);
    expect(updated?.completedAt).toBe(completedAt);
  });

  it('appends events and paginates with getEventsSince cursor', () => {
    const { store } = createStore();

    const job = store.createJob({
      type: 'eval',
      status: 'pending',
      params: { prompt: 'evaluate' },
      retryCount: 0,
      maxRetries: 1,
    });

    store.appendEvent(job.id, 'custom_event_1', { step: 1 });
    store.appendEvent(job.id, 'custom_event_2', { step: 2 });

    const allEvents = store.getEventsSince('0').filter((event) => event.jobId === job.id);
    expect(allEvents.length).toBeGreaterThanOrEqual(3);

    const cursor = allEvents[1].id;
    const page = store.getEventsSince(cursor).filter((event) => event.jobId === job.id);
    expect(page.length).toBe(allEvents.length - 2);
    expect(page[0]?.id).toBe(allEvents[2]?.id);
  });

  it('returns next runnable job based on parent dependency completion', () => {
    const { store } = createStore();

    const parent = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'parent' },
      retryCount: 0,
      maxRetries: 1,
    });

    const child = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { prompt: 'child' },
      retryCount: 0,
      maxRetries: 1,
      parentJobId: parent.id,
    });

    const first = store.getNextRunnableJob();
    expect(first?.id).toBe(parent.id);

    store.updateJob(parent.id, { status: 'completed', completedAt: Date.now() });

    const second = store.getNextRunnableJob();
    expect(second?.id).toBe(child.id);
  });

  it('reads and updates steer messages from SQLite table', () => {
    const { tempDir, store } = createStore();
    const dbPath = path.join(tempDir, '.tenet', '.state', 'tenet.db');
    const db = new Database(dbPath);

    db.prepare(
      `
      INSERT INTO steer_messages (id, timestamp, class, content, status, source, agent_response, affected_job_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('steer-1', '2026-01-01T00:00:00.000Z', 'directive', 'Prioritize tests', 'received', 'user', null, JSON.stringify(['job-1']));

    db.close();

    const unprocessed = store.getUnprocessedSteers();
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0]?.id).toBe('steer-1');
    expect(unprocessed[0]?.status).toBe('received');
    expect(unprocessed[0]?.affectedJobIds).toEqual(['job-1']);

    store.updateSteerStatus('steer-1', 'resolved', 'Done');

    const remaining = store.getUnprocessedSteers();
    expect(remaining).toHaveLength(0);
  });

  it('round-trips config values', () => {
    const { store } = createStore();

    store.setConfig('agent_override_dev', 'mock-adapter');
    expect(store.getConfig('agent_override_dev')).toBe('mock-adapter');
  });

  it('round-trips job output', () => {
    const { store } = createStore();

    const job = store.createJob({
      type: 'health_check',
      status: 'pending',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });

    const payload = { ok: true, metrics: { duration_ms: 42 } };
    store.setJobOutput(job.id, payload);

    expect(store.getJobOutput(job.id)).toEqual(payload);
  });

  it('returns aggregate job query results across statuses', () => {
    const { store } = createStore();

    store.createJob({
      type: 'dev',
      status: 'pending',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });
    store.createJob({
      type: 'eval',
      status: 'running',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });
    store.createJob({
      type: 'health_check',
      status: 'completed',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });
    store.createJob({
      type: 'compile_context',
      status: 'completed',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });
    store.createJob({
      type: 'mechanical_eval',
      status: 'blocked',
      params: {},
      retryCount: 0,
      maxRetries: 1,
    });

    expect(store.getActiveJobs()).toHaveLength(2);
    expect(store.getJobsByStatus('completed')).toHaveLength(2);
    expect(store.getCompletedCount()).toBe(2);
    expect(store.getTotalCount()).toBe(5);
    expect(store.getBlockedJobs()).toHaveLength(1);
  });
});
