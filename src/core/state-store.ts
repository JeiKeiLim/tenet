import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Job, JobStatus, SteerMessage, SteerMessageStatus } from '../types/index.js';
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

export class StateStore {
  public readonly projectPath: string;
  private readonly db: Database.Database;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    const stateDir = path.join(projectPath, '.tenet', '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const dbPath = path.join(stateDir, 'tenet.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.loadFileConfig(stateDir);
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

  getEventsSince(cursor: string): Array<{ id: string; jobId: string; event: string; data: unknown; timestamp: number }> {
    const parsedCursor = Number.parseInt(cursor, 10);
    const numericCursor = Number.isNaN(parsedCursor) ? 0 : parsedCursor;
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC').all(numericCursor) as EventRow[];
    return rows.map((row) => ({
      id: String(row.id),
      jobId: row.job_id,
      event: row.event,
      data: parseJson(row.data, null),
      timestamp: row.timestamp,
    }));
  }

  getNextRunnableJob(): Job | null {
    const row = this.db
      .prepare(
        `
        SELECT j.*
        FROM jobs j
        WHERE j.status = 'pending'
          AND (
            j.parent_job_id IS NULL
            OR EXISTS (
              SELECT 1 FROM jobs p
              WHERE p.id = j.parent_job_id
                AND p.status = 'completed'
            )
          )
        ORDER BY j.created_at ASC
        LIMIT 1
      `,
      )
      .get() as JobRow | undefined;

    return row ? this.toJob(row) : null;
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
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status = 'blocked' ORDER BY created_at ASC").all() as JobRow[];
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
      blocked: jobs.filter((j) => j.status === 'blocked'),
    });
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
      if (typeof raw.default_agent === 'string' && raw.default_agent.length > 0) {
        const existing = this.getConfig('default_agent');
        if (!existing) {
          this.setConfig('default_agent', raw.default_agent);
        }
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
        output TEXT
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
