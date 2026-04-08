import fs from 'node:fs';
import path from 'node:path';
import { StateStore } from '../core/state-store.js';
import type { Job } from '../types/index.js';

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = (pidFile: string): number | null => {
  if (!fs.existsSync(pidFile)) {
    return null;
  }

  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid) || pid <= 0) {
    return null;
  }

  return pid;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

const statusIcon = (status: Job['status']): string => {
  switch (status) {
    case 'completed': return 'done';
    case 'running': return 'RUNNING';
    case 'failed': return 'FAILED';
    case 'cancelled': return 'cancelled';
    case 'blocked': return 'blocked';
    case 'pending': return 'pending';
    default: return status;
  }
};

const printJobTable = (jobs: Job[]): void => {
  if (jobs.length === 0) {
    console.log('  (no jobs registered)');
    return;
  }

  for (const job of jobs) {
    const name = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
    const dagId = typeof job.params.dag_id === 'string' ? `${job.params.dag_id}` : '';
    const label = dagId ? `${dagId}: ${name}` : name;
    const duration = job.startedAt
      ? formatDuration((job.completedAt ?? Date.now()) - job.startedAt)
      : '-';
    const error = job.error ? ` (${job.error})` : '';
    const retry = job.retryCount > 0 ? ` [retry ${job.retryCount}/${job.maxRetries}]` : '';

    console.log(`  ${statusIcon(job.status).padEnd(10)} ${label}  ${duration}${retry}${error}`);
  }
};

export function showStatus(projectPath: string): void {
  const tenetDir = path.join(projectPath, '.tenet');
  const pidFile = path.join(tenetDir, '.state', 'server.pid');

  // Check server status
  const pid = readPid(pidFile);
  const serverAlive = pid !== null && isProcessAlive(pid);
  console.log(`Server: ${serverAlive ? `running (pid ${pid})` : 'not running'}`);
  console.log('');

  // Primary: live DB state
  let storeOpened = false;
  try {
    const stateDbPath = path.join(tenetDir, '.state', 'tenet.db');
    if (!fs.existsSync(stateDbPath)) {
      console.log('No state database found. Run `tenet init` first.');
      return;
    }

    const stateStore = new StateStore(projectPath);
    storeOpened = true;

    try {
      const allJobs = [
        ...stateStore.getJobsByStatus('running'),
        ...stateStore.getJobsByStatus('pending'),
        ...stateStore.getJobsByStatus('blocked'),
        ...stateStore.getJobsByStatus('failed'),
        ...stateStore.getJobsByStatus('completed'),
        ...stateStore.getJobsByStatus('cancelled'),
      ];

      const completed = allJobs.filter((j) => j.status === 'completed').length;
      const failed = allJobs.filter((j) => j.status === 'failed').length;
      const running = allJobs.filter((j) => j.status === 'running').length;
      const pending = allJobs.filter((j) => j.status === 'pending').length;
      const blocked = allJobs.filter((j) => j.status === 'blocked').length;

      console.log(`Jobs: ${completed} completed, ${running} running, ${pending} pending, ${failed} failed, ${blocked} blocked (${allJobs.length} total)`);
      console.log('');

      printJobTable(allJobs);

      const unprocessedSteers = stateStore.getUnprocessedSteers().length;
      if (unprocessedSteers > 0) {
        console.log('');
        console.log(`Unprocessed steer messages: ${unprocessedSteers}`);
      }
    } finally {
      stateStore.close();
    }
  } catch {
    if (!storeOpened) {
      // Fall back to markdown status file
      const statusFile = path.join(tenetDir, 'status', 'status.md');
      if (fs.existsSync(statusFile)) {
        console.log(fs.readFileSync(statusFile, 'utf8'));
      } else {
        console.log('No status information available.');
      }
    }
  }
}
