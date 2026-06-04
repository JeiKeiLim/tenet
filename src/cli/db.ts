import fs from 'node:fs';
import path from 'node:path';
import { StateStore, type DbHealthReport, type RestoreDatabaseOptions } from '../core/state-store.js';

const timestamp = (): string =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(1)} MiB`;
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

const defaultSnapshotPath = (projectPath: string): string =>
  path.join(projectPath, '.tenet', 'state-snapshot', 'tenet.db');

export const runDbSnapshot = (projectPath: string, destination?: string): string => {
  const snapshotPath = destination ? path.resolve(destination) : defaultSnapshotPath(projectPath);
  const snapshotDir = path.dirname(snapshotPath);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const tempPath = path.join(snapshotDir, `tenet.db.tmp-${process.pid}-${Date.now()}`);

  try {
    StateStore.backupDatabase(projectPath, tempPath);
    fs.renameSync(tempPath, snapshotPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
    throw error;
  }

  console.log(`Snapshot created: ${snapshotPath}`);
  return snapshotPath;
};

export const runDbRestoreSnapshot = (
  projectPath: string,
  source?: string,
  options?: RestoreDatabaseOptions,
): string => {
  const snapshotPath = source ? path.resolve(source) : defaultSnapshotPath(projectPath);
  StateStore.restoreDatabase(projectPath, snapshotPath, options);
  console.log(`Snapshot restored: ${snapshotPath}`);
  return snapshotPath;
};
