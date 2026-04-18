import fs from 'node:fs';
import path from 'node:path';
import type { Job } from '../types/index.js';

type JobSummary = {
  jobs: Job[];
  completed: number;
  total: number;
  running: Job[];
  failed: Job[];
  pending: Job[];
  blocked: Job[];
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

const jobStatusIcon = (status: Job['status']): string => {
  switch (status) {
    case 'completed': return '[x]';
    case 'running': return '[~]';
    case 'failed': return '[!]';
    case 'cancelled': return '[-]';
    case 'blocked': return '[B]';
    case 'blocked_remediation_required': return '[R]';
    case 'pending': return '[ ]';
    default: return '[ ]';
  }
};

const renderJobLine = (job: Job): string => {
  const icon = jobStatusIcon(job.status);
  const name = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
  const dagId = typeof job.params.dag_id === 'string' ? ` (${job.params.dag_id})` : '';
  const duration = job.startedAt
    ? ` — ${formatDuration((job.completedAt ?? Date.now()) - job.startedAt)}`
    : '';
  const error = job.error ? ` !! ${job.error}` : '';
  return `- ${icon} ${name}${dagId}${duration}${error}`;
};

export const writeStatusFiles = (projectPath: string, summary: JobSummary): void => {
  const statusDir = path.join(projectPath, '.tenet', 'status');
  fs.mkdirSync(statusDir, { recursive: true });

  // status.md — high-level summary
  const now = new Date().toISOString();
  const statusLines = [
    '# Tenet Status',
    '',
    `Updated: ${now}`,
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Completed | ${summary.completed} / ${summary.total} |`,
    `| Running | ${summary.running.length} |`,
    `| Pending | ${summary.pending.length} |`,
    `| Failed | ${summary.failed.length} |`,
    `| Blocked | ${summary.blocked.length} |`,
    '',
  ];

  if (summary.running.length > 0) {
    statusLines.push('## Currently Running', '');
    for (const job of summary.running) {
      statusLines.push(renderJobLine(job));
    }
    statusLines.push('');
  }

  if (summary.failed.length > 0) {
    statusLines.push('## Failed', '');
    for (const job of summary.failed) {
      statusLines.push(renderJobLine(job));
    }
    statusLines.push('');
  }

  fs.writeFileSync(path.join(statusDir, 'status.md'), statusLines.join('\n'), 'utf8');

  // job-queue.md — full job list
  const queueLines = [
    '# Job Queue',
    '',
    `Updated: ${now}`,
    '',
  ];

  for (const job of summary.jobs) {
    queueLines.push(renderJobLine(job));
  }
  queueLines.push('');

  fs.writeFileSync(path.join(statusDir, 'job-queue.md'), queueLines.join('\n'), 'utf8');
};
