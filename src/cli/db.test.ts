import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../core/state-store.js';
import { runDbRestoreSnapshot, runDbSnapshot } from './db.js';

const tempDirs: string[] = [];
const stores: StateStore[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-test-'));
  tempDirs.push(dir);
  return dir;
};

const readJobNames = (dbPath: string): string[] => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT params FROM jobs ORDER BY created_at ASC').all() as Array<{ params: string }>;
    return rows.map((row) => JSON.parse(row.params) as { name?: string }).map((params) => params.name ?? '');
  } finally {
    db.close();
  }
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

describe('db snapshot commands', () => {
  it('creates a portable snapshot that includes live WAL state', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);
    store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'from-live-wal', payload: 'x'.repeat(10_000) },
      retryCount: 0,
      maxRetries: 1,
    });

    const snapshotPath = runDbSnapshot(projectPath);

    expect(snapshotPath).toBe(path.join(projectPath, '.tenet', 'state-snapshot', 'tenet.db'));
    expect(readJobNames(snapshotPath)).toEqual(['from-live-wal']);
  });

  it('restores live state from the portable snapshot and removes sidecars', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);
    store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'snapshotted' },
      retryCount: 0,
      maxRetries: 1,
    });
    const snapshotPath = runDbSnapshot(projectPath);
    store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'after-snapshot' },
      retryCount: 0,
      maxRetries: 1,
    });
    stores.pop()?.close();

    const stateDir = path.join(projectPath, '.tenet', '.state');
    fs.writeFileSync(path.join(stateDir, 'tenet.db-wal'), 'stale wal placeholder', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'tenet.db-shm'), 'stale shm placeholder', 'utf8');

    runDbRestoreSnapshot(projectPath, snapshotPath, { force: true });

    expect(readJobNames(path.join(stateDir, 'tenet.db'))).toEqual(['snapshotted']);
    expect(fs.existsSync(path.join(stateDir, 'tenet.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'tenet.db-shm'))).toBe(false);
  });

  it('refuses to restore over WAL or SHM sidecars without force', () => {
    const projectPath = createTempDir();
    const store = new StateStore(projectPath);
    stores.push(store);
    store.createJob({
      type: 'dev',
      status: 'completed',
      params: { name: 'snapshotted' },
      retryCount: 0,
      maxRetries: 1,
    });
    const snapshotPath = runDbSnapshot(projectPath);
    stores.pop()?.close();

    const walPath = path.join(projectPath, '.tenet', '.state', 'tenet.db-wal');
    fs.writeFileSync(walPath, 'stale wal placeholder', 'utf8');

    expect(() => runDbRestoreSnapshot(projectPath, snapshotPath)).toThrow(/Refusing to restore/);
    expect(fs.readFileSync(walPath, 'utf8')).toBe('stale wal placeholder');
  });
});
