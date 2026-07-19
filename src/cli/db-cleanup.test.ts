import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../core/state-store.js';
import type { CleanupPreview } from './db-cleanup.js';
import {
  buildMenu,
  cutoffFromKeepDays,
  executeCleanup,
  renderCleanupPreview,
  runCleanupCommand,
} from './db-cleanup.js';
import type { JobStatus, JobType } from '../types/index.js';

const MS_PER_DAY = 86_400_000;

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-cleanup-test-'));
  tempDirs.push(dir);
  return dir;
};

const dbPathFor = (projectPath: string): string =>
  path.join(projectPath, '.tenet', '.state', 'tenet.db');

const openRaw = (dbPath: string, readonly = true): Database.Database =>
  new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : {});

const scalar = (dbPath: string, sql: string): number => {
  const db = openRaw(dbPath);
  try {
    const row = db.prepare(sql).get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
};

const countJobs = (dbPath: string): number => scalar(dbPath, 'SELECT COUNT(*) AS c FROM jobs');
const countEvents = (dbPath: string): number => scalar(dbPath, 'SELECT COUNT(*) AS c FROM events');
const jobIds = (dbPath: string): Set<string> => {
  const db = openRaw(dbPath);
  try {
    return new Set((db.prepare('SELECT id FROM jobs').all() as { id: string }[]).map((r) => r.id));
  } finally {
    db.close();
  }
};

/** Insert an event with an explicit (possibly old) timestamp, bypassing appendEvent's Date.now(). */
const insertEvent = (projectPath: string, jobId: string, event: string, ts: number, bytes = 0): void => {
  const db = openRaw(dbPathFor(projectPath), false);
  try {
    db.prepare('INSERT INTO events (job_id, event, data, timestamp) VALUES (?, ?, ?, ?)').run(
      jobId,
      event,
      JSON.stringify({ payload: 'x'.repeat(bytes) }),
      ts,
    );
  } finally {
    db.close();
  }
};

let counter = 0;
const seedJob = (
  store: StateStore,
  overrides: { status?: JobStatus; completedAt?: number; outputBytes?: number; type?: JobType } = {},
): string => {
  const job = store.createJob({
    type: overrides.type ?? 'dev',
    status: overrides.status ?? 'completed',
    params: { name: `job-${counter++}` },
    retryCount: 0,
    maxRetries: -1,
    completedAt: overrides.completedAt,
  });
  if (overrides.outputBytes && overrides.outputBytes > 0) {
    store.setJobOutput(job.id, { verdict: 'ok', blob: 'x'.repeat(overrides.outputBytes) });
  }
  return job.id;
};

const scanPreview = (projectPath: string, cutoffs: number[]): CleanupPreview => {
  const store = StateStore.openReadonly(projectPath);
  try {
    return store.getCleanupPreview(cutoffs);
  } finally {
    store.close();
  }
};

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const now = (): number => Date.now();

describe('StateStore cleanup — data layer', () => {
  it('status gate: non-terminal jobs are never deleted, regardless of age (AC2)', () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);

    const terminal: JobStatus[] = ['completed', 'failed', 'cancelled'];
    const protectedStatuses: JobStatus[] = ['pending', 'running', 'blocked', 'blocked_on_finding'];
    const t = now() - 100 * MS_PER_DAY;
    for (const status of terminal) seedJob(store, { status, completedAt: t });
    for (const status of protectedStatuses) seedJob(store, { status, completedAt: t });

    expect(countJobs(dbPath)).toBe(7);

    const writable = new StateStore(projectPath);
    stores.push(writable);
    writable.pruneCleanup({ mode: 'all', cutoffMs: now(), archivePath: undefined });

    expect(writable.getTotalCount()).toBe(4); // only the protected statuses survive
    for (const status of protectedStatuses) {
      expect(writable.getJobsByStatus(status).length).toBe(1);
    }
    for (const status of terminal) {
      expect(writable.getJobsByStatus(status).length).toBe(0);
    }
  });

  it('cascade + orphan sweep: deleting jobs removes their events and sweeps orphans (AC5)', () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);

    const oldJob = seedJob(store, { completedAt: now() - 30 * MS_PER_DAY });
    insertEvent(projectPath, oldJob, 'ev1', now() - 30 * MS_PER_DAY);
    insertEvent(projectPath, oldJob, 'ev2', now() - 30 * MS_PER_DAY);
    insertEvent(projectPath, 'no-such-job', 'orphan', now() - 30 * MS_PER_DAY); // orphan

    // createJob also appended a 'job_created' event for oldJob.
    expect(countEvents(dbPath)).toBe(4);

    const writable = new StateStore(projectPath);
    stores.push(writable);
    const result = writable.pruneCleanup({ mode: 'all', cutoffMs: now() - 7 * MS_PER_DAY });

    expect(result.deletedJobs).toBe(1);
    expect(result.orphanEventsSwept).toBe(1);
    expect(countEvents(dbPath)).toBe(0); // both cascade events + the orphan gone
    expect(countJobs(dbPath)).toBe(0);
  });

  it('age-banding: only finished work older than the cutoff is removed', () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);

    const oldId = seedJob(store, { completedAt: now() - 30 * MS_PER_DAY });
    const recentId = seedJob(store, { completedAt: now() - 1 * MS_PER_DAY });
    const runningId = seedJob(store, { status: 'running', completedAt: now() - 30 * MS_PER_DAY });

    const writable = new StateStore(projectPath);
    stores.push(writable);
    writable.pruneCleanup({ mode: 'all', cutoffMs: now() - 7 * MS_PER_DAY });

    const survivors = jobIds(dbPath);
    expect(survivors.has(oldId)).toBe(false);
    expect(survivors.has(recentId)).toBe(true);
    expect(survivors.has(runningId)).toBe(true); // status gate beats age
  });

  it('archive: pruned job rows (with params/output) are written to JSONL; events are not archived (AC6)', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);

    const oldId = seedJob(store, { completedAt: now() - 30 * MS_PER_DAY, outputBytes: 2_000 });
    const archivePath = path.join(projectPath, '.tenet', 'archive', 'cleanup-test.jsonl');

    const writable = new StateStore(projectPath);
    stores.push(writable);
    const result = writable.pruneCleanup({ mode: 'all', cutoffMs: now() - 7 * MS_PER_DAY, archivePath });

    expect(result.archivedJobs).toBe(1);
    expect(fs.existsSync(archivePath)).toBe(true);

    const lines = fs.readFileSync(archivePath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record.id).toBe(oldId);
    expect(typeof record.params).toBe('string'); // raw column (params holds run_slug/source_job_id when set)
    expect(typeof record.output).toBe('string');
    expect(String(record.output)).toContain('blob'); // the verdict payload survived
    expect(record.status).toBe('completed');
  });

  it('VACUUM: file shrinks after deleting bulky output (AC7)', () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);
    for (let i = 0; i < 8; i++) seedJob(store, { completedAt: now() - 30 * MS_PER_DAY, outputBytes: 300_000 });

    stores.pop()?.close();
    const sizeBefore = fs.statSync(dbPath).size;
    expect(sizeBefore).toBeGreaterThan(2_000_000);

    const writable = new StateStore(projectPath);
    const result = writable.pruneCleanup({ mode: 'all', cutoffMs: now() - 7 * MS_PER_DAY });
    writable.close();

    expect(result.vacuumed).toBe(true);
    expect(result.bytesBefore).toBe(sizeBefore);
    expect(result.bytesAfter).toBeLessThan(sizeBefore);
    expect(result.bytesAfter).toBeLessThan(sizeBefore * 0.25); // reclaimed the bulk
  });

  it('preview: per-cutoff reclaim reflects age-banding', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);
    seedJob(store, { completedAt: now() - 10 * MS_PER_DAY, outputBytes: 50_000 });
    seedJob(store, { completedAt: now() - 40 * MS_PER_DAY, outputBytes: 50_000 });

    const c7 = cutoffFromKeepDays(7);
    const c30 = cutoffFromKeepDays(30);
    const c90 = cutoffFromKeepDays(90);
    const preview = scanPreview(projectPath, [c7, c30, c90]);
    const at7 = preview.reclaim.find((r) => r.cutoffMs === c7)!;
    const at30 = preview.reclaim.find((r) => r.cutoffMs === c30)!;
    const at90 = preview.reclaim.find((r) => r.cutoffMs === c90)!;

    expect(at7.all.jobCount).toBe(2); // both jobs older than 7d
    expect(at30.all.jobCount).toBe(1); // only the 40d job is older than 30d
    expect(at90.all.jobCount).toBe(0); // neither older than 90d
    expect(at7.all.bytes).toBeGreaterThan(at30.all.bytes);
  });
});

describe('executeCleanup / runCleanupCommand', () => {
  it('dry-run changes nothing', () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);
    seedJob(store, { completedAt: now() - 30 * MS_PER_DAY, outputBytes: 10_000 });

    const before = countJobs(dbPath);
    const preview = scanPreview(projectPath, [cutoffFromKeepDays(7)]);
    const result = executeCleanup(projectPath, { mode: 'all', cutoffMs: cutoffFromKeepDays(7), dryRun: true, noArchive: true }, preview);

    expect(result.kind).toBe('dry-run');
    expect(countJobs(dbPath)).toBe(before); // untouched
  });

  it('non-interactive prune via runCleanupCommand removes old finished work and archives', async () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);
    seedJob(store, { completedAt: now() - 30 * MS_PER_DAY, outputBytes: 5_000 });
    seedJob(store, { status: 'running' });
    expect(countJobs(dbPath)).toBe(2);

    // stdin is not a TTY under vitest -> non-interactive path.
    await runCleanupCommand(projectPath, { keepDays: 7, yes: true });

    expect(countJobs(dbPath)).toBe(1); // only the running job remains
    const archives = fs.readdirSync(path.join(projectPath, '.tenet', 'archive'));
    expect(archives.some((f) => /^cleanup-.*\.jsonl$/.test(f))).toBe(true);
  });

  it('non-interactive with no decision flag is read-only (never auto-prunes)', async () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);
    seedJob(store, { completedAt: now() - 30 * MS_PER_DAY, outputBytes: 5_000 });

    const before = countJobs(dbPath);
    await runCleanupCommand(projectPath, {});
    expect(countJobs(dbPath)).toBe(before);
  });

  it('events-only mode drops old events but keeps every job', async () => {
    const projectPath = createTempDir();
    const dbPath = dbPathFor(projectPath);
    const store = new StateStore(projectPath);
    stores.push(store);

    const keepId = seedJob(store, { completedAt: now() - 30 * MS_PER_DAY });
    insertEvent(projectPath, keepId, 'old_event', now() - 30 * MS_PER_DAY, 10_000); // old -> dropped
    insertEvent(projectPath, keepId, 'recent_event', now() - 1 * MS_PER_DAY, 10_000); // recent -> kept
    insertEvent(projectPath, 'orphan', 'orphan_event', now() - 30 * MS_PER_DAY); // swept

    // createJob also appended a 'job_created' event for keepId (recent -> kept).
    expect(countEvents(dbPath)).toBe(4);
    await runCleanupCommand(projectPath, { keepDays: 7, mode: 'events-only', yes: true });

    expect(countJobs(dbPath)).toBe(1); // job kept
    expect(countEvents(dbPath)).toBe(2); // job_created + recent_event remain; old_event + orphan gone
  });

  it('empty DB: reports nothing-to-clean and does not throw', async () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath); // creates an empty DB
    stores.push(store);
    store.close();
    stores.pop();

    await expect(runCleanupCommand(projectPath, {})).resolves.toBeUndefined();
    expect(countJobs(dbPathFor(projectPath))).toBe(0);
  });
});

describe('rendering + menu (pure, adaptive — AC10)', () => {
  const fakePreview = (over: Partial<CleanupPreview>): CleanupPreview => ({
    fileBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    pageSize: 4096,
    pageCount: 0,
    freelistCount: 0,
    categoryBytes: { eventsData: 0, jobsOutput: 0, jobsParams: 0, jobsError: 0 },
    statusCounts: {},
    orphanEvents: { count: 0, bytes: 0 },
    reclaim: [],
    ...over,
  });

  it('characterizes a freelist-heavy DB as VACUUM-shrinkable without deleting', () => {
    const out = renderCleanupPreview(
      fakePreview({ fileBytes: 10 * 1024 * 1024, pageCount: 2600, freelistCount: 2000 }),
    );
    expect(out).toContain('VACUUM can shrink it without deleting');
  });

  it('characterizes a real-data DB as having no quick compact', () => {
    const out = renderCleanupPreview(fakePreview({ fileBytes: 10 * 1024 * 1024, freelistCount: 0 }));
    expect(out).toContain('no quick "compact"');
  });

  it('buildMenu drops no-op cutoffs and keeps reclaiming ones', () => {
    const t = now();
    const big = 100 * 1024 * 1024;
    const preview = fakePreview({
      statusCounts: { completed: 500 },
      reclaim: [
        { cutoffMs: t, all: { jobCount: 500, eventCount: 0, bytes: big }, eventsOnly: { eventCount: 0, bytes: 0 } },
        { cutoffMs: cutoffFromKeepDays(7, t), all: { jobCount: 300, eventCount: 0, bytes: big }, eventsOnly: { eventCount: 0, bytes: big } },
        { cutoffMs: cutoffFromKeepDays(30, t), all: { jobCount: 0, eventCount: 0, bytes: 0 }, eventsOnly: { eventCount: 0, bytes: 0 } },
      ],
    });
    const labels = buildMenu(preview, t).groups.flatMap((g) => g.items).map((i) => i.label);
    expect(labels.some((l) => l.includes('keep the last 7 days'))).toBe(true); // reclaims
    expect(labels.some((l) => l.includes('keep the last 30 days'))).toBe(false); // no-op, dropped
    expect(labels.some((l) => l.includes('drop logs older than 7 days'))).toBe(true); // events-only reclaims
    expect(labels.some((l) => l.includes('remove ALL finished work'))).toBe(true); // reset: terminal jobs exist
  });

  it('buildMenu on a DB with no finished work offers no destructive reset', () => {
    const t = now();
    const preview = fakePreview({ statusCounts: { running: 3 } }); // no terminal jobs
    const labels = buildMenu(preview, t).groups.flatMap((g) => g.items).map((i) => i.label);
    expect(labels.some((l) => l.includes('remove ALL finished work'))).toBe(false);
  });
});
