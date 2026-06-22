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

  it('does not return jobs until all DAG dependencies are completed', () => {
    const { store } = createStore();

    const rootA = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { dag_id: 'job-a', feature: 'oauth', prompt: 'a' },
      retryCount: 0,
      maxRetries: 1,
    });
    const rootB = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { dag_id: 'job-b', feature: 'oauth', prompt: 'b' },
      retryCount: 0,
      maxRetries: 1,
    });
    const join = store.createJob({
      type: 'integration_test',
      status: 'pending',
      params: {
        dag_id: 'e2e-1',
        feature: 'oauth',
        depends_on: ['job-a', 'job-b'],
        prompt: 'join',
      },
      retryCount: 0,
      maxRetries: 1,
      parentJobId: rootA.id,
    });

    expect(store.getNextRunnableJob()?.id).toBe(rootA.id);

    store.updateJob(rootA.id, { status: 'completed', completedAt: Date.now() });
    expect(store.getNextRunnableJob()?.id).toBe(rootB.id);
    expect(store.getNextRunnableJob()?.id).not.toBe(join.id);

    store.updateJob(rootB.id, { status: 'completed', completedAt: Date.now() });
    expect(store.getNextRunnableJob()?.id).toBe(join.id);
  });

  describe('steer inbox', () => {
    const insertSteer = (
      db: Database,
      id: string,
      ts: string,
      cls: 'context' | 'directive' | 'emergency',
      status: string,
      source: string,
      content = `steer ${id}`,
    ): void => {
      db.prepare(
        `INSERT INTO steer_messages (id, timestamp, class, content, status, source, agent_response, affected_job_ids)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '[]')`,
      ).run(id, ts, cls, content, status, source);
    };

    it('returns the inbox split by source and retires steers by id', () => {
      const { tempDir, store } = createStore();
      const db = new Database(path.join(tempDir, '.tenet', '.state', 'tenet.db'));
      insertSteer(db, 'u1', '2026-01-01T00:00:00.000Z', 'directive', 'received', 'user', 'Prioritize tests');
      db.close();

      const inbox = store.getSteerInbox({ agentLimit: 50 });
      expect(inbox.userMessages).toHaveLength(1);
      expect(inbox.userMessages[0]?.id).toBe('u1');
      expect(inbox.userMessages[0]?.status).toBe('received');
      expect(inbox.agentMessages).toHaveLength(0);
      expect(inbox.totals).toEqual({ user: 1, agent: 0 });

      const { updated } = store.updateSteersStatus(['u1'], 'resolved', 'Done');
      expect(updated).toBe(1);

      const after = store.getSteerInbox({ agentLimit: 50 });
      expect(after.userMessages).toHaveLength(0);
      expect(after.totals).toEqual({ user: 0, agent: 0 });
    });

    it('returns all user steers uncapped but caps agent steers to the most recent N', () => {
      const { tempDir, store } = createStore();
      const db = new Database(path.join(tempDir, '.tenet', '.state', 'tenet.db'));
      insertSteer(db, 'u1', '2026-01-01T00:00:01.000Z', 'context', 'received', 'user');
      insertSteer(db, 'u2', '2026-01-01T00:00:02.000Z', 'context', 'received', 'user');
      insertSteer(db, 'u3', '2026-01-01T00:00:03.000Z', 'context', 'received', 'user');
      insertSteer(db, 'a1', '2026-01-01T00:00:01.000Z', 'context', 'received', 'agent');
      insertSteer(db, 'a2', '2026-01-01T00:00:02.000Z', 'context', 'received', 'agent');
      insertSteer(db, 'a3', '2026-01-01T00:00:03.000Z', 'context', 'received', 'agent');
      insertSteer(db, 'a4', '2026-01-01T00:00:04.000Z', 'context', 'received', 'agent');
      insertSteer(db, 'a5', '2026-01-01T00:00:05.000Z', 'context', 'received', 'agent');
      db.close();

      const inbox = store.getSteerInbox({ agentLimit: 3 });
      expect(inbox.userMessages.map((m) => m.id)).toEqual(['u1', 'u2', 'u3']); // uncapped, ASC
      expect(inbox.agentMessages.map((m) => m.id)).toEqual(['a3', 'a4', 'a5']); // most-recent 3, ASC
      expect(inbox.totals).toEqual({ user: 3, agent: 5 }); // true counts, not the capped slice
    });

    it('counts unresolved steers by source without loading bodies', () => {
      const { store } = createStore();
      store.createSteer({ class: 'directive', content: 'user d', source: 'user' });
      store.createSteer({ class: 'context', content: 'agent c1', source: 'agent' });
      store.createSteer({ class: 'context', content: 'agent c2', source: 'agent' });

      expect(store.countUnprocessedSteers()).toEqual({ user: 1, agent: 2, total: 3 });
    });

    it('sweeps only agent-context steers, leaving user steers and directives untouched', () => {
      const { tempDir, store } = createStore();
      const db = new Database(path.join(tempDir, '.tenet', '.state', 'tenet.db'));
      insertSteer(db, 'ac1', '2026-01-01T00:00:01.000Z', 'context', 'received', 'agent'); // swept
      insertSteer(db, 'ac2', '2026-01-01T00:00:02.000Z', 'context', 'received', 'agent'); // swept
      insertSteer(db, 'ad1', '2026-01-01T00:00:03.000Z', 'directive', 'received', 'agent'); // kept (directive)
      insertSteer(db, 'uc1', '2026-01-01T00:00:04.000Z', 'context', 'received', 'user'); // kept (user)
      insertSteer(db, 'ud1', '2026-01-01T00:00:05.000Z', 'directive', 'received', 'user'); // kept (user)
      db.close();

      const result = store.sweepAgentContextSteers('resolved', 'slice boundary');
      expect(result.swept).toBe(2);
      expect(result.ids.sort()).toEqual(['ac1', 'ac2']);

      const inbox = store.getSteerInbox({ agentLimit: 50 });
      expect(inbox.userMessages.map((m) => m.id).sort()).toEqual(['uc1', 'ud1']);
      expect(inbox.agentMessages.map((m) => m.id)).toEqual(['ad1']); // agent directive survived
      expect(inbox.totals).toEqual({ user: 2, agent: 1 });
    });

    it('filters to a specific job (and broadcasts) when jobId is given', () => {
      const { tempDir, store } = createStore();
      const db = new Database(path.join(tempDir, '.tenet', '.state', 'tenet.db'));
      db.prepare(
        `INSERT INTO steer_messages (id, timestamp, class, content, status, source, agent_response, affected_job_ids)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run('t1', '2026-01-01T00:00:00.000Z', 'directive', 'for job-1', 'received', 'user', JSON.stringify(['job-1']));
      db.prepare(
        `INSERT INTO steer_messages (id, timestamp, class, content, status, source, agent_response, affected_job_ids)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run('other', '2026-01-01T00:00:00.500Z', 'directive', 'for job-2', 'received', 'user', JSON.stringify(['job-2']));
      db.prepare(
        `INSERT INTO steer_messages (id, timestamp, class, content, status, source, agent_response, affected_job_ids)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run('b1', '2026-01-01T00:00:01.000Z', 'context', 'broadcast', 'received', 'agent', JSON.stringify([]));
      db.close();

      const inbox = store.getSteerInbox({ jobId: 'job-1', agentLimit: 50 });
      expect(inbox.userMessages.map((m) => m.id)).toEqual(['t1']); // targeted, not 'other'
      expect(inbox.agentMessages.map((m) => m.id)).toEqual(['b1']); // broadcast included
    });
  });

  it('round-trips config values', () => {
    const { store } = createStore();

    store.setConfig('agent_override_dev', 'mock-adapter');
    expect(store.getConfig('agent_override_dev')).toBe('mock-adapter');
  });

  it('syncs JSON config values into SQLite config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
    tempDirs.push(tempDir);
    const stateDir = path.join(tempDir, '.tenet', '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ max_retries: 'unlimited', timeout_minutes: 120 }),
      'utf8',
    );

    const store = new StateStore(tempDir);
    stores.push(store);

    expect(store.getConfig('max_retries')).toBe('-1');
    expect(store.getConfig('timeout_minutes')).toBe('120');
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

  it('opens read-only without syncing JSON config into SQLite', () => {
    const { tempDir, store } = createStore();
    store.close();
    stores.pop();

    const stateDir = path.join(tempDir, '.tenet', '.state');
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ max_retries: 7 }),
      'utf8',
    );

    const readonlyStore = StateStore.openReadonly(tempDir);
    stores.push(readonlyStore);

    expect(readonlyStore.getConfig('max_retries')).toBeNull();
  });

  it('runs health checks on a valid WAL database', () => {
    const { tempDir, store } = createStore();
    store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'done' },
      retryCount: 0,
      maxRetries: 1,
    });

    const report = StateStore.checkDatabase(tempDir);

    expect(report.ok).toBe(true);
    expect(report.quickCheck).toEqual(['ok']);
    expect(report.integrityCheck).toEqual(['ok']);
    expect(report.indexConsistency.every((check) => check.ok)).toBe(true);
  });

  it('allows nested MCP-style stores to open the same project database', () => {
    const { tempDir, store } = createStore();
    const nestedStore = new StateStore(tempDir, { healthCheck: true });
    stores.push(nestedStore);

    const job = store.createJob({
      type: 'dev',
      status: 'pending',
      params: { name: 'parent-server-job' },
      retryCount: 0,
      maxRetries: 1,
    });
    nestedStore.appendEvent(job.id, 'nested_server_seen');

    expect(nestedStore.getJob(job.id)?.id).toBe(job.id);
    expect(nestedStore.getEventsForJob(job.id).some((event) => event.event === 'nested_server_seen')).toBe(true);
  });

  it('creates a SQLite-safe backup that includes WAL state while the store is open', () => {
    const { tempDir, store } = createStore();
    const job = store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'from-wal', payload: 'x'.repeat(10_000) },
      retryCount: 0,
      maxRetries: 1,
    });
    const backupPath = path.join(tempDir, '.tenet', '.state', 'backups', 'backup.db');

    StateStore.backupDatabase(tempDir, backupPath);

    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(integrity.map((row) => row.integrity_check)).toEqual(['ok']);
      const row = backupDb.prepare('SELECT params FROM jobs WHERE id = ?').get(job.id) as { params: string } | undefined;
      expect(row ? JSON.parse(row.params) : null).toMatchObject({ name: 'from-wal' });
    } finally {
      backupDb.close();
    }
  });

  it('can checkpoint writable WAL state', () => {
    const { store } = createStore();

    expect(() => store.checkpoint('PASSIVE')).not.toThrow();
  });
});
