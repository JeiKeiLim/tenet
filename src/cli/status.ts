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

const formatTimestamp = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
};

const printJobTable = (jobs: Job[]): void => {
  if (jobs.length === 0) {
    console.log('  (no jobs registered)');
    return;
  }

  for (const job of jobs) {
    const name = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
    const dagId = typeof job.params.dag_id === 'string' ? `${job.params.dag_id}` : '';
    const dependsOn = Array.isArray(job.params.depends_on) && job.params.depends_on.length > 0
      ? ` [after ${(job.params.depends_on as string[]).join(', ')}]`
      : '';
    const label = dagId ? `${dagId}: ${name}` : name;
    const duration = job.startedAt
      ? formatDuration((job.completedAt ?? Date.now()) - job.startedAt)
      : '-';
    const error = job.error ? ` (${job.error})` : '';
    const retry = job.retryCount > 0 ? ` [retry ${job.retryCount}/${job.maxRetries}]` : '';

    // Show timestamps: registered → started → completed
    const timestamps: string[] = [];
    if (job.createdAt) timestamps.push(`reg ${formatTimestamp(job.createdAt)}`);
    if (job.startedAt) timestamps.push(`start ${formatTimestamp(job.startedAt)}`);
    if (job.completedAt) timestamps.push(`done ${formatTimestamp(job.completedAt)}`);
    const timeInfo = timestamps.length > 0 ? `  (${timestamps.join(' → ')})` : '';

    console.log(`  ${statusIcon(job.status).padEnd(10)} ${label}  ${duration}${retry}${dependsOn}${error}${timeInfo}`);
  }
};

type StatusOptions = {
  all?: boolean;
};

export function showStatus(projectPath: string, options?: StatusOptions): void {
  const showAll = options?.all ?? false;
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
      const cancelled = allJobs.filter((j) => j.status === 'cancelled').length;
      const failed = allJobs.filter((j) => j.status === 'failed').length;
      const running = allJobs.filter((j) => j.status === 'running').length;
      const pending = allJobs.filter((j) => j.status === 'pending').length;
      const blocked = allJobs.filter((j) => j.status === 'blocked').length;

      console.log(`Jobs: ${completed} done, ${running} running, ${pending} pending, ${failed} failed, ${blocked} blocked (${allJobs.length} total)`);
      console.log('');

      // Active jobs: running, pending, blocked (not completed, cancelled, or failed)
      const activeJobs = allJobs.filter((j) => ['running', 'pending', 'blocked'].includes(j.status));
      if (activeJobs.length > 0) {
        printJobTable(activeJobs);
      } else if (allJobs.length > 0) {
        console.log('  All jobs completed.');
      }

      // Terminal jobs: show only with --all flag
      const terminalJobs = allJobs.filter((j) => ['completed', 'cancelled', 'failed'].includes(j.status));
      if (terminalJobs.length > 0) {
        if (showAll) {
          console.log('');
          console.log(`History (${terminalJobs.length}):`);
          printJobTable(terminalJobs);
        } else if (activeJobs.length > 0 || terminalJobs.length > 0) {
          console.log('');
          console.log(`  + ${completed} done, ${failed} failed, ${cancelled} cancelled (use --all to show)`);
        }
      }

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
