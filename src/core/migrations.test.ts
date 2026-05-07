import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initProject } from '../cli/init.js';
import {
  CURRENT_DB_SCHEMA_VERSION,
  DB_SCHEMA_VERSION_KEY,
  UnsupportedDbVersionError,
  UpgradeRequiredError,
} from './migrations.js';
import { StateStore } from './state-store.js';

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createTempDir = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-migration-test-'));
  tempDirs.push(tempDir);
  return tempDir;
};

const createLegacyStateDb = (projectPath: string): void => {
  const stateDir = path.join(projectPath, '.tenet', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'tenet.db'));
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      params TEXT NOT NULL,
      agent_name TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_heartbeat INTEGER,
      retry_count INTEGER NOT NULL,
      max_retries INTEGER NOT NULL,
      parent_job_id TEXT,
      error TEXT,
      output TEXT
    );

    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      event TEXT NOT NULL,
      data TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (
      id, type, status, params, agent_name, created_at, retry_count, max_retries, parent_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'parent-job',
    'dev',
    'blocked_remediation_required',
    JSON.stringify({ name: 'report', report_only: true }),
    'codex',
    now,
    0,
    3,
    null,
  );
  db.prepare(
    `INSERT INTO jobs (
      id, type, status, params, agent_name, created_at, retry_count, max_retries, parent_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'child-job',
    'dev',
    'completed',
    JSON.stringify({ name: 'remediation', remediation_for: 'parent-job' }),
    'codex',
    now + 1,
    0,
    3,
    null,
  );
  db.prepare('INSERT INTO events (job_id, event, data, timestamp) VALUES (?, ?, ?, ?)')
    .run('parent-job', 'remediation_resumed', JSON.stringify({ child_job_id: 'child-job' }), now + 2);
  db.close();
};

const createFutureSchemaDb = (projectPath: string): string => {
  const stateDir = path.join(projectPath, '.tenet', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, 'tenet.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
    DB_SCHEMA_VERSION_KEY,
    String(CURRENT_DB_SCHEMA_VERSION + 1),
  );
  db.close();
  return dbPath;
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

describe('DB migrations', () => {
  it('initializes fresh databases at the current schema version', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);

    expect(store.getConfig(DB_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_DB_SCHEMA_VERSION));
  });

  it('requires explicit upgrade for legacy unversioned databases', () => {
    const projectPath = createTempDir();
    createLegacyStateDb(projectPath);

    expect(() => new StateStore(projectPath)).toThrow(UpgradeRequiredError);
  });

  it('rejects databases from newer unsupported schema versions', () => {
    const projectPath = createTempDir();
    createFutureSchemaDb(projectPath);

    expect(() => new StateStore(projectPath)).toThrow(UnsupportedDbVersionError);
  });

  it('rejects future schema versions in upgrade mode before mutating schema', () => {
    const projectPath = createTempDir();
    const dbPath = createFutureSchemaDb(projectPath);

    expect(() => new StateStore(projectPath, { migrate: true })).toThrow(UnsupportedDbVersionError);

    const after = new Database(dbPath);
    try {
      const jobsTable = after
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
        .get();
      expect(jobsTable).toBeUndefined();
    } finally {
      after.close();
    }
  });

  it('migrates legacy remediation runtime state in upgrade mode', () => {
    const projectPath = createTempDir();
    createLegacyStateDb(projectPath);

    const store = new StateStore(projectPath, { migrate: true });
    stores.push(store);

    expect(store.getConfig(DB_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_DB_SCHEMA_VERSION));
    expect(store.getJob('parent-job')?.status).toBe('blocked_on_finding');
    expect(store.getJob('child-job')?.params).toMatchObject({
      name: 'remediation',
      blocking_finding_for: 'parent-job',
    });
    expect(store.getJob('child-job')?.params.remediation_for).toBeUndefined();
    expect(
      store.getEventsForJob('parent-job').some((event) => event.event === 'blocking_finding_resolved'),
    ).toBe(true);
  });

  it('backs up and migrates legacy DB state through tenet init --upgrade', () => {
    const projectPath = createTempDir();
    fs.mkdirSync(path.join(projectPath, '.tenet'), { recursive: true });
    createLegacyStateDb(projectPath);

    initProject(projectPath, { upgrade: true });

    const backupFiles = fs
      .readdirSync(path.join(projectPath, '.tenet', '.state'))
      .filter((file) => file.startsWith('tenet.db.bak-'));
    expect(backupFiles).toHaveLength(1);

    const store = new StateStore(projectPath);
    stores.push(store);

    expect(store.getConfig(DB_SCHEMA_VERSION_KEY)).toBe(String(CURRENT_DB_SCHEMA_VERSION));
    expect(store.getJob('parent-job')?.status).toBe('blocked_on_finding');
    expect(store.getJob('child-job')?.params).toMatchObject({
      blocking_finding_for: 'parent-job',
    });
    expect(store.getJob('child-job')?.params.remediation_for).toBeUndefined();
  });
});
