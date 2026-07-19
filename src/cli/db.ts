import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { StateStore, type DbHealthReport, type RestoreDatabaseOptions } from '../core/state-store.js';

export const timestamp = (): string =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(2)} GiB`;
  return `${(gib / 1024).toFixed(2)} TiB`;
};

const printFileInfo = (label: string, filePath: string): void => {
  if (!fs.existsSync(filePath)) {
    console.log(`${label}: missing`);
    return;
  }

  const stat = fs.statSync(filePath);
  console.log(`${label}: ${formatBytes(stat.size)} modified ${stat.mtime.toISOString()}`);
};

const printHealthReport = (report: DbHealthReport): void => {
  console.log(`Database: ${report.dbPath}`);
  printFileInfo('tenet.db', report.dbPath);
  printFileInfo('tenet.db-wal', report.walPath);
  printFileInfo('tenet.db-shm', report.shmPath);
  console.log('');

  console.log(`journal_mode: ${report.journalMode ?? '(unknown)'}`);
  console.log(`page_size: ${report.pageSize ?? '(unknown)'}`);
  console.log(`page_count: ${report.pageCount ?? '(unknown)'}`);
  console.log(`freelist_count: ${report.freelistCount ?? '(unknown)'}`);
  console.log('');

  console.log(`quick_check: ${report.quickCheck.length === 0 ? '(not run)' : report.quickCheck.join('; ')}`);
  console.log(`integrity_check: ${report.integrityCheck.length === 0 ? '(not run)' : report.integrityCheck.join('; ')}`);

  if (report.indexConsistency.length > 0) {
    console.log('');
    console.log('Index consistency:');
    for (const check of report.indexConsistency) {
      console.log(`  ${check.name}: ${check.ok ? 'ok' : 'mismatch'}`);
      if (!check.ok) {
        console.log(`    indexed: ${JSON.stringify(check.indexed)}`);
        console.log(`    table_scan: ${JSON.stringify(check.tableScan)}`);
      }
    }
  }

  if (report.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const error of report.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log('');
  console.log(`Result: ${report.ok ? 'ok' : 'unsafe'}`);
};

export const runDbCheck = (projectPath: string): boolean => {
  const report = StateStore.checkDatabase(projectPath, {
    integrityCheck: true,
    indexConsistency: true,
  });
  printHealthReport(report);
  return report.ok;
};

export const runDbBackup = (projectPath: string, destination?: string): string => {
  const backupPath = destination
    ? path.resolve(destination)
    : path.join(projectPath, '.tenet', '.state', 'backups', `tenet-${timestamp()}.db`);
  StateStore.backupDatabase(projectPath, backupPath);
  console.log(`Backup created: ${backupPath}`);
  return backupPath;
};

export type SnapshotOptions = { compress?: boolean };

// Gzip magic number (first two bytes): 0x1f 0x8b.
const isGzipFile = (filePath: string): boolean => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
};

const defaultSnapshotPath = (projectPath: string, compress: boolean): string =>
  path.join(projectPath, '.tenet', 'state-snapshot', compress ? 'tenet.db.gz' : 'tenet.db');

// Prefer the compressed snapshot when restoring without an explicit source;
// fall back to a legacy plain tenet.db so old snapshots keep restoring.
const resolveDefaultSnapshotSource = (projectPath: string): string => {
  const dir = path.join(projectPath, '.tenet', 'state-snapshot');
  const gz = path.join(dir, 'tenet.db.gz');
  return fs.existsSync(gz) ? gz : path.join(dir, 'tenet.db');
};

export const runDbSnapshot = (
  projectPath: string,
  destination?: string,
  options?: SnapshotOptions,
): string => {
  const compress = options?.compress ?? true;
  const snapshotPath = destination
    ? path.resolve(destination)
    : defaultSnapshotPath(projectPath, compress);
  const snapshotDir = path.dirname(snapshotPath);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const tempPlain = path.join(snapshotDir, `tenet.db.tmp-${process.pid}-${Date.now()}`);

  try {
    // VACUUM INTO a temp plain SQLite file (also asserts the live DB is healthy).
    StateStore.backupDatabase(projectPath, tempPlain);
    const rawSize = fs.statSync(tempPlain).size;

    if (compress) {
      const packed = zlib.gzipSync(fs.readFileSync(tempPlain), { level: 9 });
      fs.writeFileSync(snapshotPath, packed);
      fs.rmSync(tempPlain, { force: true });
      const ratio = rawSize > 0 ? Math.max(0, Math.round((1 - packed.length / rawSize) * 100)) : 0;
      const savings = ratio > 0 ? `, ${ratio}% smaller than ${formatBytes(rawSize)} raw` : '';
      console.log(`Snapshot created: ${snapshotPath} (${formatBytes(packed.length)}${savings})`);
    } else {
      fs.renameSync(tempPlain, snapshotPath);
      console.log(`Snapshot created: ${snapshotPath} (${formatBytes(rawSize)})`);
    }
  } catch (error) {
    if (fs.existsSync(tempPlain)) {
      fs.rmSync(tempPlain, { force: true });
    }
    throw error;
  }

  return snapshotPath;
};

export const runDbRestoreSnapshot = (
  projectPath: string,
  source?: string,
  options?: RestoreDatabaseOptions,
): string => {
  const resolvedSource = source ? path.resolve(source) : resolveDefaultSnapshotSource(projectPath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`snapshot does not exist: ${resolvedSource}`);
  }

  const snapshotDir = path.dirname(resolvedSource);
  let restoreSource = resolvedSource;
  let tempDecompressed: string | null = null;

  // Auto-detect gzip via magic bytes so restore accepts both .db.gz and plain .db
  // regardless of filename (handles legacy snapshots and custom destinations).
  if (isGzipFile(resolvedSource)) {
    tempDecompressed = path.join(snapshotDir, `tenet.db.tmp-restore-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tempDecompressed, zlib.gunzipSync(fs.readFileSync(resolvedSource)));
    restoreSource = tempDecompressed;
  }

  try {
    StateStore.restoreDatabase(projectPath, restoreSource, options);
    console.log(`Snapshot restored: ${resolvedSource}${tempDecompressed ? ' (decompressed)' : ''}`);
  } finally {
    if (tempDecompressed) {
      fs.rmSync(tempDecompressed, { force: true });
    }
  }

  return resolvedSource;
};
