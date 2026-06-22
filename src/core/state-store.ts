import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Job, JobStatus, SteerMessage, SteerMessageStatus } from '../types/index.js';
import {
  CURRENT_DB_SCHEMA_VERSION,
  DB_SCHEMA_VERSION_KEY,
  MIGRATIONS,
  UnsupportedDbVersionError,
  UpgradeRequiredError,
} from './migrations.js';
import { parseMaxRetries, parseTimeoutMinutes } from './runtime-config.js';
import { writeStatusFiles } from './status-writer.js';

type JobRow = {
  id: string;
  type: string;
  status: string;
  params: string;
  agent_name: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  last_heartbeat: number | null;
  retry_count: number;
  max_retries: number;
  parent_job_id: string | null;
  error: string | null;
  output: string | null;
  server_id: string | null;
};

type EventRow = {
  id: number;
  job_id: string;
  event: string;
  data: string | null;
  timestamp: number;
};

type SteerRow = {
  id: string;
  timestamp: string;
  class: string;
  content: string;
  status: string;
  source: string | null;
  agent_response: string | null;
  affected_job_ids: string | null;
};

type EventRecord = { id: string; jobId: string; event: string; data: unknown; timestamp: number };

export type StateStoreOptions = {
  migrate?: boolean;
  readonly?: boolean;
  loadFileConfig?: boolean;
  healthCheck?: boolean;
};

type CountRow = {
  count: number;
};

type StatusCountRow = {
  status: string;
  count: number;
};

export type DbIndexConsistencyCheck = {
  name: string;
  ok: boolean;
  indexed: Record<string, number>;
  tableScan: Record<string, number>;
};

export type DbHealthReport = {
  ok: boolean;
  dbPath: string;
  walPath: string;
  shmPath: string;
  walExists: boolean;
  shmExists: boolean;
  journalMode?: string;
  pageSize?: number;
  pageCount?: number;
  freelistCount?: number;
  quickCheck: string[];
  integrityCheck: string[];
  indexConsistency: DbIndexConsistencyCheck[];
  errors: string[];
};

export type RestoreDatabaseOptions = {
  force?: boolean;
};

export class DbHealthError extends Error {
  constructor(public readonly report: DbHealthReport) {
    const details = [
      ...report.errors,
      ...report.quickCheck.filter((line) => line !== 'ok'),
      ...report.integrityCheck.filter((line) => line !== 'ok'),
      ...report.indexConsistency
        .filter((check) => !check.ok)
        .map((check) => `${check.name} indexed counts do not match table scan counts`),
    ];
    super(
      [
        'Tenet DB health check failed. Refusing to start to avoid making SQLite state worse.',
        `Database: ${report.dbPath}`,
        report.walExists ? `WAL: ${report.walPath}` : undefined,
        report.shmExists ? `SHM: ${report.shmPath}` : undefined,
        ...details.slice(0, 8).map((detail) => `- ${detail}`),
        'Run `tenet db check` for diagnostics and use a verified backup before recovery.',
      ]
        .filter((line): line is string => typeof line === 'string')
        .join('\n'),
    );
    this.name = 'DbHealthError';
  }
}

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (value == null) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const statePaths = (projectPath: string): { stateDir: string; dbPath: string; walPath: string; shmPath: string } => {
  const stateDir = path.join(projectPath, '.tenet', '.state');
  const dbPath = path.join(stateDir, 'tenet.db');
  return {
    stateDir,
    dbPath,
    walPath: `${dbPath}-wal`,
    shmPath: `${dbPath}-shm`,
  };
};

const fileSize = (filePath: string): number | null => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
};

const sqliteString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const pragmaTextRows = (db: Database.Database, pragma: string): string[] => {
  const result = db.pragma(pragma) as unknown;
  if (!Array.isArray(result)) {
    return [String(result)];
  }

  return result.map((row) => {
    if (row && typeof row === 'object') {
      const firstValue = Object.values(row as Record<string, unknown>)[0];
      return String(firstValue);
    }
    return String(row);
  });
};

const simpleNumberPragma = (db: Database.Database, pragma: string): number | undefined => {
  const value = db.pragma(pragma, { simple: true }) as unknown;
  return typeof value === 'number' ? value : undefined;
};

const simpleStringPragma = (db: Database.Database, pragma: string): string | undefined => {
  const value = db.pragma(pragma, { simple: true }) as unknown;
  return typeof value === 'string' ? value : undefined;
};

const mapStatusRows = (rows: StatusCountRow[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.status, row.count]));

const mapsEqual = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) {
      return false;
    }
  }
  return true;
};

export class StateStore {
  public readonly projectPath: string;
  private readonly db: Database.Database;
  private readonly readonlyMode: boolean;

  constructor(projectPath: string, options?: StateStoreOptions) {
    this.projectPath = projectPath;
    const readonlyMode = options?.readonly === true;
    this.readonlyMode = readonlyMode;
    const { stateDir, dbPath } = statePaths(projectPath);

    if (!readonlyMode) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const dbExisted = fs.existsSync(dbPath);
    if (!readonlyMode && dbExisted && options?.healthCheck === true) {
      StateStore.assertHealthy(projectPath);
    }

    this.db = readonlyMode
      ? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 })
      : new Database(dbPath, { timeout: 10_000 });

    try {
      if (readonlyMode) {
        this.openReadonlySchema();
      } else {
        this.openSchema(dbExisted, options?.migrate === true);
        this.configureWritablePragmas();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }

    if (!readonlyMode && options?.loadFileConfig !== false) {
      this.loadFileConfig(stateDir);
    }
  }

  static openReadonly(projectPath: string): StateStore {
    return new StateStore(projectPath, { readonly: true, loadFileConfig: false });
  }

  static checkDatabase(projectPath: string, options?: { integrityCheck?: boolean; indexConsistency?: boolean }): DbHealthReport {
    const { dbPath, walPath, shmPath } = statePaths(projectPath);
    const report: DbHealthReport = {
      ok: false,
      dbPath,
      walPath,
      shmPath,
      walExists: fs.existsSync(walPath),
      shmExists: fs.existsSync(shmPath),
      quickCheck: [],
      integrityCheck: [],
      indexConsistency: [],
      errors: [],
    };

    if (!fs.existsSync(dbPath)) {
      report.errors.push('tenet.db does not exist');
      return report;
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 });
      db.pragma('busy_timeout = 10000');
      report.journalMode = simpleStringPragma(db, 'journal_mode');
      report.pageSize = simpleNumberPragma(db, 'page_size');
      report.pageCount = simpleNumberPragma(db, 'page_count');
      report.freelistCount = simpleNumberPragma(db, 'freelist_count');
      report.quickCheck = pragmaTextRows(db, 'quick_check');
      if (options?.integrityCheck !== false) {
        report.integrityCheck = pragmaTextRows(db, 'integrity_check');
      }
      if (options?.indexConsistency !== false) {
        report.indexConsistency = StateStore.checkCoreIndexConsistency(db);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(message);
    } finally {
      db?.close();
    }

    report.ok =
      report.errors.length === 0 &&
      (report.quickCheck.length === 0 || report.quickCheck.every((line) => line === 'ok')) &&
      (report.integrityCheck.length === 0 || report.integrityCheck.every((line) => line === 'ok')) &&
      report.indexConsistency.every((check) => check.ok);

    return report;
  }

  static assertHealthy(projectPath: string): DbHealthReport {
    const report = StateStore.checkDatabase(projectPath, {
      integrityCheck: true,
      indexConsistency: true,
    });
    if (!report.ok) {
      throw new DbHealthError(report);
    }
    return report;
  }

  static backupDatabase(projectPath: string, destinationPath: string): DbHealthReport {
    const report = StateStore.assertHealthy(projectPath);
    const { dbPath } = statePaths(projectPath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (fs.existsSync(destinationPath)) {
      throw new Error(`backup destination already exists: ${destinationPath}`);
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 });
    try {
      db.pragma('busy_timeout = 10000');
      db.exec(`VACUUM INTO ${sqliteString(destinationPath)}`);
    } finally {
      db.close();
    }

    const backupDb = new Database(destinationPath, { readonly: true, fileMustExist: true, timeout: 10_000 });
    try {
      const integrity = pragmaTextRows(backupDb, 'integrity_check');
      if (!integrity.every((line) => line === 'ok')) {
        throw new Error(`backup integrity_check failed: ${integrity.join('; ')}`);
      }
    } finally {
      backupDb.close();
    }

    return report;
  }

  static restoreDatabase(projectPath: string, sourcePath: string, options?: RestoreDatabaseOptions): void {
    const resolvedSourcePath = path.resolve(sourcePath);
    const { stateDir, dbPath, walPath, shmPath } = statePaths(projectPath);
    if (!fs.existsSync(resolvedSourcePath)) {
      throw new Error(`snapshot does not exist: ${resolvedSourcePath}`);
    }

    StateStore.assertStandaloneDatabaseHealthy(resolvedSourcePath, 'snapshot');

    const sidecars = [walPath, shmPath]
      .map((filePath) => ({ filePath, size: fileSize(filePath) }))
      .filter((entry): entry is { filePath: string; size: number } => entry.size !== null && entry.size > 0);
    if (sidecars.length > 0 && options?.force !== true) {
      throw new Error(
        [
          'Refusing to restore while SQLite WAL/SHM sidecar files exist.',
          'These files can mean Tenet is still running or has uncheckpointed runtime state.',
          ...sidecars.map((entry) => `- ${entry.filePath} (${entry.size} bytes)`),
          'Stop Tenet processes first, then rerun with --force if you intentionally want the snapshot to replace live state.',
        ].join('\n'),
      );
    }

    fs.mkdirSync(stateDir, { recursive: true });
    const tempPath = path.join(stateDir, `tenet.db.restore-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.copyFileSync(resolvedSourcePath, tempPath);
      StateStore.assertStandaloneDatabaseHealthy(tempPath, 'restore copy');
      for (const sidecarPath of [walPath, shmPath]) {
        if (fs.existsSync(sidecarPath)) {
          fs.rmSync(sidecarPath, { force: true });
        }
      }
      fs.renameSync(tempPath, dbPath);
      StateStore.assertHealthy(projectPath);
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
      throw error;
    }
  }

  createJob(job: Omit<Job, 'id' | 'createdAt'>): Job {
    const created: Job = {
      ...job,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `
        INSERT INTO jobs (
          id, type, status, params, agent_name, created_at, started_at, completed_at,
          last_heartbeat, retry_count, max_retries, parent_job_id, error, output
        ) VALUES (
          @id, @type, @status, @params, @agent_name, @created_at, @started_at, @completed_at,
          @last_heartbeat, @retry_count, @max_retries, @parent_job_id, @error, @output
        )
      `,
      )
      .run({
        id: created.id,
        type: created.type,
        status: created.status,
        params: JSON.stringify(created.params),
        agent_name: created.agentName ?? null,
        created_at: created.createdAt,
        started_at: created.startedAt ?? null,
        completed_at: created.completedAt ?? null,
        last_heartbeat: created.lastHeartbeat ?? null,
        retry_count: created.retryCount,
        max_retries: created.maxRetries,
        parent_job_id: created.parentJobId ?? null,
        error: created.error ?? null,
        output: null,
      });

    this.appendEvent(created.id, 'job_created', {
      type: created.type,
      status: created.status,
    });

    return created;
  }

  getJob(jobId: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? this.toJob(row) : null;
  }

  updateJob(jobId: string, updates: Partial<Job>): void {
    const current = this.getJob(jobId);
    if (!current) {
      return;
    }

    // Explicit undefined values in updates should clear the field (not fall through to current)
    const merged: Job = { ...current, id: current.id, createdAt: current.createdAt };
    for (const key of Object.keys(updates) as Array<keyof Job>) {
      if (key === 'id' || key === 'createdAt') continue;
      (merged as unknown as Record<string, unknown>)[key] = updates[key];
    }
    // Fill remaining fields from current where not explicitly set
    for (const key of Object.keys(current) as Array<keyof Job>) {
      if (key in updates || key === 'id' || key === 'createdAt') continue;
      (merged as unknown as Record<string, unknown>)[key] = current[key];
    }
    this.db
      .prepare(
        `
        UPDATE jobs
        SET
          type = @type,
          status = @status,
          params = @params,
          agent_name = @agent_name,
          started_at = @started_at,
          completed_at = @completed_at,
          last_heartbeat = @last_heartbeat,
          retry_count = @retry_count,
          max_retries = @max_retries,
          parent_job_id = @parent_job_id,
          error = @error
        WHERE id = @id
      `,
      )
      .run({
        id: merged.id,
        type: merged.type,
        status: merged.status,
        params: JSON.stringify(merged.params),
        agent_name: merged.agentName ?? null,
        started_at: merged.startedAt ?? null,
        completed_at: merged.completedAt ?? null,
        last_heartbeat: merged.lastHeartbeat ?? null,
        retry_count: merged.retryCount,
        max_retries: merged.maxRetries,
        parent_job_id: merged.parentJobId ?? null,
        error: merged.error ?? null,
      });

    if (updates.status) {
      this.appendEvent(jobId, 'job_status_changed', { status: updates.status });
      this.syncStatusFiles();
    }
  }

  getActiveJobs(): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC`).all() as JobRow[];
    return rows.map((row) => this.toJob(row));
  }

  getJobsByStatus(status: JobStatus): Job[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC').all(status) as JobRow[];
    return rows.map((row) => this.toJob(row));
  }

  appendEvent(jobId: string, event: string, data?: unknown): void {
    const payload = data === undefined ? null : JSON.stringify(data);
    this.db
      .prepare('INSERT INTO events (job_id, event, data, timestamp) VALUES (?, ?, ?, ?)')
      .run(jobId, event, payload, Date.now());
  }

  getEventsSince(cursor: string): EventRecord[] {
    const parsedCursor = Number.parseInt(cursor, 10);
    const numericCursor = Number.isNaN(parsedCursor) ? 0 : parsedCursor;
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC').all(numericCursor) as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  getEventsForJob(jobId: string, limit = 50): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, limit) as EventRow[];
    return rows.reverse().map((row) => this.toEvent(row));
  }

  getLatestEventForJob(jobId: string, eventName: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE job_id = ? AND event = ? ORDER BY id DESC LIMIT 1')
      .get(jobId, eventName) as EventRow | undefined;
    return row ? this.toEvent(row) : null;
  }

  private toEvent(row: EventRow): EventRecord {
    return {
      id: String(row.id),
      jobId: row.job_id,
      event: row.event,
      data: parseJson(row.data, null),
      timestamp: row.timestamp,
    };
  }

  getNextRunnableJob(): Job | null {
    const allRows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as JobRow[];
    const jobs = allRows.map((row) => this.toJob(row));
    const byId = new Map(jobs.map((job) => [job.id, job]));

    for (const job of jobs) {
      if (job.status !== 'pending') {
        continue;
      }

      if (!this.parentDependencyCompleted(job, byId)) {
        continue;
      }

      if (!this.dagDependenciesCompleted(job, jobs)) {
        continue;
      }

      return job;
    }

    return null;
  }

  private parentDependencyCompleted(job: Job, byId: Map<string, Job>): boolean {
    if (!job.parentJobId) {
      return true;
    }

    return byId.get(job.parentJobId)?.status === 'completed';
  }

  private dagDependenciesCompleted(job: Job, jobs: Job[]): boolean {
    const dependsOn = Array.isArray(job.params.depends_on)
      ? job.params.depends_on.filter((dep): dep is string => typeof dep === 'string' && dep.length > 0)
      : [];

    if (dependsOn.length === 0) {
      return true;
    }

    const feature = typeof job.params.feature === 'string' ? job.params.feature : undefined;

    return dependsOn.every((dependencyId) => {
      const candidates = jobs
        .filter((candidate) => candidate.id !== job.id)
        .filter((candidate) => candidate.createdAt <= job.createdAt)
        .filter((candidate) => {
          const dagId = typeof candidate.params.dag_id === 'string' ? candidate.params.dag_id : undefined;
          return candidate.id === dependencyId || dagId === dependencyId;
        });

      const scopedCandidates = feature
        ? candidates.filter((candidate) => candidate.params.feature === feature)
        : candidates;

      const candidatePool = scopedCandidates.length > 0 ? scopedCandidates : candidates;
      const latestCandidate = candidatePool.sort((a, b) => b.createdAt - a.createdAt)[0];

      return latestCandidate?.status === 'completed';
    });
  }

  getCompletedCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'completed'").get() as { count: number };
    return row.count;
  }

  getTotalCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
    return row.count;
  }

  getBlockedJobs(): Job[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('blocked', 'blocked_on_finding') ORDER BY created_at ASC",
      )
      .all() as JobRow[];
    return rows.map((row) => this.toJob(row));
  }

  getChildJobs(parentJobId: string): Job[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY created_at ASC')
      .all(parentJobId) as JobRow[];
    return rows.map((row) => this.toJob(row));
  }

  getEvalsForSource(sourceJobId: string): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE json_extract(params, '$.source_job_id') = ?
         ORDER BY created_at ASC`,
      )
      .all(sourceJobId) as JobRow[];
    return rows.map((row) => this.toJob(row));
  }

  createSteer(params: {
    class: SteerMessage['class'];
    content: string;
    source?: SteerMessage['source'];
    affectedJobIds?: string[];
  }): SteerMessage {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const source = params.source ?? 'agent';
    this.db
      .prepare(
        `INSERT INTO steer_messages (id, timestamp, class, content, status, source, agent_response, affected_job_ids)
         VALUES (?, ?, ?, ?, 'received', ?, NULL, ?)`,
      )
      .run(id, timestamp, params.class, params.content, source, JSON.stringify(params.affectedJobIds ?? []));
    return {
      id,
      timestamp,
      class: params.class,
      content: params.content,
      status: 'received',
      source,
      affectedJobIds: params.affectedJobIds ?? [],
    };
  }

  getUnprocessedSteers(jobId?: string): SteerMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM steer_messages WHERE status != 'resolved' ORDER BY timestamp ASC")
      .all() as SteerRow[];
    const messages = rows.map((row) => this.toSteerMessage(row));
    if (!jobId) {
      return messages;
    }
    // Filter to messages that target this specific job or have no target (broadcast)
    return messages.filter(
      (m) => !m.affectedJobIds || m.affectedJobIds.length === 0 || m.affectedJobIds.includes(jobId),
    );
  }

  updateSteerStatus(id: string, status: SteerMessageStatus, agentResponse?: string): void {
    this.db
      .prepare('UPDATE steer_messages SET status = ?, agent_response = ? WHERE id = ?')
      .run(status, agentResponse ?? null, id);
  }

  getJobOutput(jobId: string): unknown {
    const row = this.db.prepare('SELECT output FROM jobs WHERE id = ?').get(jobId) as { output: string | null } | undefined;
    return parseJson(row?.output ?? null, null);
  }

  setJobOutput(jobId: string, output: unknown): void {
    this.db.prepare('UPDATE jobs SET output = ? WHERE id = ?').run(JSON.stringify(output), jobId);
    this.appendEvent(jobId, 'job_output_updated', output);
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  syncStatusFiles(): void {
    const allRows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as JobRow[];
    const jobs = allRows.map((row) => this.toJob(row));

    writeStatusFiles(this.projectPath, {
      jobs,
      completed: jobs.filter((j) => j.status === 'completed').length,
      total: jobs.length,
      running: jobs.filter((j) => j.status === 'running'),
      failed: jobs.filter((j) => j.status === 'failed'),
      pending: jobs.filter((j) => j.status === 'pending'),
      blocked: jobs.filter(
        (j) => j.status === 'blocked' || j.status === 'blocked_on_finding',
      ),
    });
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE'): void {
    if (this.readonlyMode) {
      throw new Error('cannot checkpoint a read-only StateStore');
    }
    this.db.pragma(`wal_checkpoint(${mode})`);
  }

  close(): void {
    this.db.close();
  }

  private loadFileConfig(stateDir: string): void {
    const configPath = path.join(stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      // JSON config file is the source of truth — always sync to SQLite
      if (typeof raw.default_agent === 'string' && raw.default_agent.length > 0) {
        this.setConfig('default_agent', raw.default_agent);
      }
      const maxRetries =
        typeof raw.max_retries === 'number' || typeof raw.max_retries === 'string'
          ? parseMaxRetries(raw.max_retries)
          : null;
      if (maxRetries !== null) {
        this.setConfig('max_retries', String(maxRetries));
      }

      const timeoutMinutes =
        typeof raw.timeout_minutes === 'number' || typeof raw.timeout_minutes === 'string'
          ? parseTimeoutMinutes(raw.timeout_minutes)
          : null;
      if (timeoutMinutes !== null) {
        this.setConfig('timeout_minutes', String(timeoutMinutes));
      }
    } catch {
      return;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
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
        output TEXT,
        server_id TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event TEXT NOT NULL,
        data TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steer_messages (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        class TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        agent_response TEXT,
        affected_job_ids TEXT
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
      CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id);
      CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
      CREATE INDEX IF NOT EXISTS idx_steer_status ON steer_messages(status);
    `);
  }

  private configureWritablePragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 10000');
    this.db.pragma('wal_autocheckpoint = 1000');
    this.db.pragma('foreign_keys = ON');
  }

  private openReadonlySchema(): void {
    const schemaVersion = this.readSchemaVersion();
    if (schemaVersion === null || schemaVersion < CURRENT_DB_SCHEMA_VERSION) {
      throw new UpgradeRequiredError(this.projectPath, schemaVersion, CURRENT_DB_SCHEMA_VERSION);
    }

    if (schemaVersion > CURRENT_DB_SCHEMA_VERSION) {
      throw new UnsupportedDbVersionError(this.projectPath, schemaVersion, CURRENT_DB_SCHEMA_VERSION);
    }
  }

  private openSchema(dbExisted: boolean, migrate: boolean): void {
    if (!dbExisted) {
      this.initSchema();
      this.setSchemaVersion(CURRENT_DB_SCHEMA_VERSION);
      return;
    }

    const schemaVersion = this.readSchemaVersion();
    if (migrate) {
      if (schemaVersion !== null && schemaVersion > CURRENT_DB_SCHEMA_VERSION) {
        throw new UnsupportedDbVersionError(this.projectPath, schemaVersion, CURRENT_DB_SCHEMA_VERSION);
      }

      this.initSchema();
      this.migrateSchema(schemaVersion ?? 0);
      return;
    }

    if (schemaVersion === null || schemaVersion < CURRENT_DB_SCHEMA_VERSION) {
      throw new UpgradeRequiredError(this.projectPath, schemaVersion, CURRENT_DB_SCHEMA_VERSION);
    }

    if (schemaVersion > CURRENT_DB_SCHEMA_VERSION) {
      throw new UnsupportedDbVersionError(this.projectPath, schemaVersion, CURRENT_DB_SCHEMA_VERSION);
    }

    this.initSchema();
  }

  private static assertStandaloneDatabaseHealthy(dbPath: string, label: string): void {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10_000 });
      db.pragma('busy_timeout = 10000');
      const integrity = pragmaTextRows(db, 'integrity_check');
      if (!integrity.every((line) => line === 'ok')) {
        throw new Error(`${label} integrity_check failed: ${integrity.join('; ')}`);
      }
    } finally {
      db?.close();
    }
  }

  private static checkCoreIndexConsistency(db: Database.Database): DbIndexConsistencyCheck[] {
    const jobsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
      .get() as { name: string } | undefined;
    if (!jobsTable) {
      return [];
    }

    const checks: DbIndexConsistencyCheck[] = [];
    const indexedStatus = mapStatusRows(
      db
        .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status')
        .all() as StatusCountRow[],
    );
    const tableScanStatus = mapStatusRows(
      db
        .prepare('SELECT status, COUNT(*) AS count FROM jobs NOT INDEXED GROUP BY status ORDER BY status')
        .all() as StatusCountRow[],
    );
    checks.push({
      name: 'jobs.status',
      ok: mapsEqual(indexedStatus, tableScanStatus),
      indexed: indexedStatus,
      tableScan: tableScanStatus,
    });

    const indexedParentNull = db
      .prepare('SELECT COUNT(*) AS count FROM jobs WHERE parent_job_id IS NULL')
      .get() as CountRow;
    const tableScanParentNull = db
      .prepare('SELECT COUNT(*) AS count FROM jobs NOT INDEXED WHERE parent_job_id IS NULL')
      .get() as CountRow;
    checks.push({
      name: 'jobs.parent_job_id_null',
      ok: indexedParentNull.count === tableScanParentNull.count,
      indexed: { null_parent: indexedParentNull.count },
      tableScan: { null_parent: tableScanParentNull.count },
    });

    return checks;
  }

  private readSchemaVersion(): number | null {
    const configTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config'")
      .get() as { name: string } | undefined;
    if (!configTable) {
      return null;
    }

    const row = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(DB_SCHEMA_VERSION_KEY) as { value: string } | undefined;
    if (!row) {
      return null;
    }

    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private setSchemaVersion(version: number): void {
    this.db
      .prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(DB_SCHEMA_VERSION_KEY, String(version));
  }

  private migrateSchema(fromVersion: number): void {
    if (fromVersion > CURRENT_DB_SCHEMA_VERSION) {
      throw new UnsupportedDbVersionError(this.projectPath, fromVersion, CURRENT_DB_SCHEMA_VERSION);
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= fromVersion) {
        continue;
      }

      const run = this.db.transaction(() => {
        migration.up(this.db);
        this.setSchemaVersion(migration.version);
        this.appendEvent('system', 'db_migration_applied', {
          version: migration.version,
          name: migration.name,
        });
      });
      run();
    }

    const after = this.readSchemaVersion();
    if (after !== CURRENT_DB_SCHEMA_VERSION) {
      throw new Error(`failed to migrate Tenet DB to schema ${CURRENT_DB_SCHEMA_VERSION}`);
    }
  }

  resetOrphanedJobs(currentServerId: string, staleAfterMs: number): number {
    const cutoff = Date.now() - staleAfterMs;
    const orphaned = this.db
      .prepare(
        `SELECT id, server_id, started_at, last_heartbeat FROM jobs
         WHERE status = 'running' AND (server_id IS NULL OR server_id != @serverId)
           AND COALESCE(last_heartbeat, started_at, created_at) <= @cutoff
         ORDER BY created_at ASC`,
      )
      .all({ serverId: currentServerId, cutoff }) as Array<{
        id: string;
        server_id: string | null;
        started_at: number | null;
        last_heartbeat: number | null;
      }>;

    if (orphaned.length === 0) {
      return 0;
    }

    const update = this.db.prepare(
      `UPDATE jobs
       SET status = 'pending', started_at = NULL, last_heartbeat = NULL, server_id = NULL
       WHERE id = @id`,
    );

    for (const job of orphaned) {
      update.run({ id: job.id });
      this.appendEvent(job.id, 'job_status_changed', {
        status: 'pending',
        reason: 'orphan_reset_after_stale_heartbeat',
      });
      this.appendEvent(job.id, 'job_orphan_reset', {
        previous_server_id: job.server_id,
        current_server_id: currentServerId,
        stale_after_ms: staleAfterMs,
        started_at: job.started_at,
        last_heartbeat: job.last_heartbeat,
      });
    }

    this.syncStatusFiles();
    return orphaned.length;
  }

  setJobServerId(jobId: string, serverId: string): void {
    this.db.prepare('UPDATE jobs SET server_id = @serverId WHERE id = @jobId').run({ serverId, jobId });
  }

  private toJob(row: JobRow): Job {
    return {
      id: row.id,
      type: row.type as Job['type'],
      status: row.status as JobStatus,
      params: parseJson<Record<string, unknown>>(row.params, {}),
      agentName: row.agent_name ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      lastHeartbeat: row.last_heartbeat ?? undefined,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      parentJobId: row.parent_job_id ?? undefined,
      error: row.error ?? undefined,
      serverId: row.server_id ?? undefined,
    };
  }

  private toSteerMessage(row: SteerRow): SteerMessage {
    return {
      id: row.id,
      timestamp: row.timestamp,
      class: row.class as SteerMessage['class'],
      content: row.content,
      status: row.status as SteerMessageStatus,
      source: (row.source as SteerMessage['source']) ?? 'user',
      agentResponse: row.agent_response ?? undefined,
      affectedJobIds: parseJson<string[]>(row.affected_job_ids, []),
    };
  }
}
