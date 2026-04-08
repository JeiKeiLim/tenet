import fs from 'node:fs';
import path from 'node:path';
import { StateStore } from '../core/state-store.js';

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

export function showStatus(projectPath: string): void {
  const statusFile = path.join(projectPath, '.tenet', 'status', 'status.md');
  const pidFile = path.join(projectPath, '.tenet', '.state', 'server.pid');

  if (fs.existsSync(statusFile)) {
    const statusContent = fs.readFileSync(statusFile, 'utf8');
    console.log(statusContent);
  } else {
    console.log('No status file found at .tenet/status/status.md');
  }

  const pid = readPid(pidFile);
  if (pid === null || !isProcessAlive(pid)) {
    return;
  }

  const stateStore = new StateStore(projectPath);
  try {
    const active = stateStore.getActiveJobs().length;
    const completed = stateStore.getCompletedCount();
    const blocked = stateStore.getBlockedJobs().length;

    console.log('\nLive Server Stats');
    console.log(`- active jobs: ${active}`);
    console.log(`- completed jobs: ${completed}`);
    console.log(`- blocked jobs: ${blocked}`);
  } finally {
    stateStore.close();
  }
}
