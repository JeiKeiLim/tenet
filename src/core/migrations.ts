import type Database from 'better-sqlite3';

export const DB_SCHEMA_VERSION_KEY = 'db_schema_version';
export const CURRENT_DB_SCHEMA_VERSION = 1;

export class UpgradeRequiredError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly currentVersion: number | null,
    public readonly requiredVersion: number,
  ) {
    const current = currentVersion === null ? 'legacy/unversioned' : String(currentVersion);
    super(
      `Tenet DB schema ${current} requires upgrade to ${requiredVersion}. ` +
      'Close your agent, run `tenet init --upgrade` in the project root, then restart your agent.',
    );
    this.name = 'UpgradeRequiredError';
  }
}

export class UnsupportedDbVersionError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly currentVersion: number,
    public readonly supportedVersion: number,
  ) {
    super(
      `Tenet DB schema ${currentVersion} is newer than this Tenet version supports (${supportedVersion}). ` +
      'Upgrade Tenet before opening this project.',
    );
    this.name = 'UnsupportedDbVersionError';
  }
}

export type Migration = {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
};

const hasColumn = (db: Database.Database, table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
};

const migrateLegacyRemediationState = (db: Database.Database): void => {
  if (!hasColumn(db, 'jobs', 'server_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN server_id TEXT');
  }

  db.prepare(
    "UPDATE jobs SET status = 'blocked_on_finding' WHERE status = 'blocked_remediation_required'",
  ).run();

  const rows = db
    .prepare("SELECT id, params FROM jobs WHERE params LIKE '%\"remediation_for\"%'")
    .all() as Array<{ id: string; params: string }>;
  const updateParams = db.prepare('UPDATE jobs SET params = ? WHERE id = ?');

  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.params) as Record<string, unknown>;
    } catch {
      continue;
    }

    const remediationFor = parsed.remediation_for;
    if (typeof remediationFor === 'string' && typeof parsed.blocking_finding_for !== 'string') {
      parsed.blocking_finding_for = remediationFor;
    }
    delete parsed.remediation_for;
    updateParams.run(JSON.stringify(parsed), row.id);
  }

  db.prepare(
    "UPDATE events SET event = 'blocking_finding_resolved' WHERE event = 'remediation_resumed'",
  ).run();
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline_legacy_db_and_blocking_finding_rename',
    up: migrateLegacyRemediationState,
  },
];
