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

type Slice = { number: number; name: string };
type SliceInfo = { deliveryMode: 'agile' | 'autonomous'; slices: Slice[] };

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const DELIVERY_MODE_RE = /delivery_mode:\s*(\S+)/;
const SLICE_HEADING_RE = /^### Slice (\d+):\s*(.+?)\s*$/gm;
const SLICE_PLAN_RE = /## Slice plan([\s\S]*?)(?=\n## |$)/;
const DAG_ID_SLICE_RE = /^slice-(\d+)-/;

const readLatestSpec = (projectPath: string): string | null => {
  const specDir = path.join(projectPath, '.tenet', 'spec');
  if (!fs.existsSync(specDir)) return null;
  const files = fs
    .readdirSync(specDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    return fs.readFileSync(path.join(specDir, files[0]), 'utf8');
  } catch {
    return null;
  }
};

const parseSliceInfo = (specContent: string): SliceInfo => {
  let deliveryMode: SliceInfo['deliveryMode'] = 'autonomous';
  const fmMatch = specContent.match(FRONTMATTER_RE);
  if (fmMatch) {
    const dmMatch = fmMatch[1].match(DELIVERY_MODE_RE);
    if (dmMatch && dmMatch[1] === 'agile') deliveryMode = 'agile';
  }

  const slices: Slice[] = [];
  if (deliveryMode === 'agile') {
    const planMatch = specContent.match(SLICE_PLAN_RE);
    if (planMatch) {
      const sliceSection = planMatch[1];
      let m: RegExpExecArray | null;
      SLICE_HEADING_RE.lastIndex = 0;
      while ((m = SLICE_HEADING_RE.exec(sliceSection)) !== null) {
        slices.push({ number: Number.parseInt(m[1], 10), name: m[2].trim() });
      }
    }
  }

  return { deliveryMode, slices };
};

const sliceNumberForJob = (job: Job): number | null => {
  const dagId = typeof job.params.dag_id === 'string' ? job.params.dag_id : job.id;
  const m = dagId.match(DAG_ID_SLICE_RE);
  return m ? Number.parseInt(m[1], 10) : null;
};

const computeSliceProgress = (jobs: Job[], slices: Slice[]): string | null => {
  if (slices.length === 0) return null;

  const sliceJobNums = jobs.map(sliceNumberForJob).filter((n): n is number => n !== null);
  if (sliceJobNums.length === 0) return null;

  const activeNums = jobs
    .filter((j) => j.status === 'running' || j.status === 'pending')
    .map(sliceNumberForJob)
    .filter((n): n is number => n !== null);

  const currentNum = activeNums.length > 0 ? Math.min(...activeNums) : Math.max(...sliceJobNums);
  const slice = slices.find((s) => s.number === currentNum);
  if (!slice) return null;

  return `Slice ${slice.number} of ${slices.length} in progress: ${slice.name}`;
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
    case 'blocked_on_finding': return '[F]';
    case 'pending': return '[ ]';
    default: return '[ ]';
  }
};

const dagIdOf = (job: Job): string | null => {
  const { dag_id } = job.params;
  return typeof dag_id === 'string' && dag_id.length > 0 ? dag_id : null;
};

/**
 * Plan-order comparator: dag_id (natural/numeric) first, falling back to
 * created_at so ad-hoc jobs (no dag_id) still order deterministically.
 * Shared by the CLI `tenet status` table and the generated job-queue.md so
 * the queue reads in dependency order instead of insertion/rowid order.
 */
export const compareJobsByPlan = (a: Job, b: Job): number => {
  const aDag = dagIdOf(a);
  const bDag = dagIdOf(b);
  if (aDag && bDag) {
    const cmp = aDag.localeCompare(bDag, undefined, { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return cmp;
  } else if (aDag) {
    return -1;
  } else if (bDag) {
    return 1;
  }
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
};

export const sortJobsByPlan = (jobs: readonly Job[]): Job[] => [...jobs].sort(compareJobsByPlan);

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

  // Slice-level progress (agile mode only — silent no-op otherwise).
  const specContent = readLatestSpec(projectPath);
  const sliceInfo = specContent ? parseSliceInfo(specContent) : null;
  const sliceProgress =
    sliceInfo && sliceInfo.deliveryMode === 'agile'
      ? computeSliceProgress(summary.jobs, sliceInfo.slices)
      : null;

  // Sort rendered lists in plan order (dag_id natural, then created_at).
  const runningSorted = sortJobsByPlan(summary.running);
  const failedSorted = sortJobsByPlan(summary.failed);
  const queueSorted = sortJobsByPlan(summary.jobs);

  // status.md — high-level summary
  const now = new Date().toISOString();
  const statusLines = [
    '# Tenet Status',
    '',
    `Updated: ${now}`,
    '',
  ];

  if (sliceProgress) {
    statusLines.push(sliceProgress, '');
  }

  statusLines.push(
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Completed | ${summary.completed} / ${summary.total} |`,
    `| Running | ${summary.running.length} |`,
    `| Pending | ${summary.pending.length} |`,
    `| Failed | ${summary.failed.length} |`,
    `| Blocked | ${summary.blocked.length} |`,
    '',
  );

  if (runningSorted.length > 0) {
    statusLines.push('## Currently Running', '');
    for (const job of runningSorted) {
      statusLines.push(renderJobLine(job));
    }
    statusLines.push('');
  }

  if (failedSorted.length > 0) {
    statusLines.push('## Failed', '');
    for (const job of failedSorted) {
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

  for (const job of queueSorted) {
    queueLines.push(renderJobLine(job));
  }
  queueLines.push('');

  fs.writeFileSync(path.join(statusDir, 'job-queue.md'), queueLines.join('\n'), 'utf8');
};
