import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { checkForUpdate } from '../../core/update-checker.js';
import type { Job, JobStatus, ProjectStatus } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

const extractRawOutput = (output: unknown): string | undefined => {
  if (!output || typeof output !== 'object') {
    return undefined;
  }
  const container = output as Record<string, unknown>;
  const raw = container.output;
  if (typeof raw === 'string') {
    return raw;
  }
  return undefined;
};

const extractJsonObject = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  const stripped = raw.trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1].trim(), stripped] : [stripped];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* continue */
    }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* continue */
      }
    }
  }
  return undefined;
};

const findLatestE2eStatus = (stateStore: StateStore): string | undefined => {
  // Scan completed interaction_e2e critic jobs in reverse-chronological order
  const completed = stateStore
    .getJobsByStatus('completed' as Job['status'])
    .filter((j) => j.type === 'interaction_e2e')
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

  if (completed.length === 0) {
    return undefined;
  }

  const raw = extractRawOutput(stateStore.getJobOutput(completed[0].id));
  const parsed = extractJsonObject(raw);
  const status = parsed?.layer2_status;
  return typeof status === 'string' ? status : undefined;
};

/**
 * Maximum number of job rows returned by view="queue". The list is oldest-first
 * (by created_at), so truncation keeps the longest-waiting jobs visible — the
 * ones most likely to be stale cleanup targets.
 */
const QUEUE_CAP = 100;

const QUEUE_STATUSES_DEFAULT: JobStatus[] = ['pending', 'running'];
const QUEUE_STATUSES_FULL: JobStatus[] = ['pending', 'running', 'blocked', 'blocked_on_finding'];

const jobDisplayName = (job: Job): string => {
  const name = job.params.name;
  return typeof name === 'string' && name.length > 0 ? name : job.id.slice(0, 8);
};

/**
 * Summarize a job for the queue view. Exposes only identity + status + age +
 * staleness — deliberately NOT params/prompt (keeps the payload small and avoids
 * leaking prompt content). `stale` is derived only from the existing heartbeat
 * bar (running jobs); pending jobs are never auto-stale, so callers judge them
 * by age_ms.
 */
const summarizeJob = (job: Job, now: number, heartbeatTimeoutMs: number): Record<string, unknown> => {
  let stale = false;
  let staleReason: string | undefined;
  if (job.status === 'running' && typeof job.lastHeartbeat === 'number') {
    if (now - job.lastHeartbeat > heartbeatTimeoutMs) {
      stale = true;
      staleReason = 'heartbeat_timeout';
    }
  }

  const row: Record<string, unknown> = {
    id: job.id,
    type: job.type,
    status: job.status,
    name: jobDisplayName(job),
    age_ms: Math.max(0, now - job.createdAt),
    stale,
  };
  if (staleReason) {
    row.stale_reason = staleReason;
  }
  return row;
};

export const registerTenetGetStatusTool = (
  registerTool: RegisterTool,
  stateStore: StateStore,
  jobManager: JobManager,
): void => {
  const startedAt = Date.now();

  registerTool(
    'tenet_get_status',
    {
      description:
        'Get high-level project summary status. Also surfaces the most recent interaction-e2e critic status ' +
        'so callers can distinguish "fully verified" from "passed with browser exploration skipped/applicable". ' +
        'Pass view="queue" to also receive the non-terminal job list (id/type/status/name/age_ms/stale) — the ' +
        'default pending+running set, or blocked/blocked_on_finding too with include_blocked=true — so a caller ' +
        'can inspect stale jobs and cancel them via tenet_cancel_job. Pending jobs have no staleness bar; judge ' +
        'them by age_ms. The list is oldest-first, capped at 100 rows (truncated=true if more exist).',
      inputSchema: z.object({
        view: z
          .enum(['summary', 'queue'])
          .optional()
          .describe(
            'summary = high-level counts only (default, unchanged). queue = also return the non-terminal job list with ids so stale jobs can be inspected and cancelled.',
          ),
        include_blocked: z
          .boolean()
          .optional()
          .describe(
            'With view="queue": also include blocked and blocked_on_finding jobs. Default false (pending + running only). Ignored for summary.',
          ),
      }),
    },
    async ({ view, include_blocked }) => {
      const now = Date.now();
      const completed = stateStore.getCompletedCount();
      const total = stateStore.getTotalCount();
      const blocked = stateStore.getBlockedJobs().length;
      const running = stateStore.getJobsByStatus('running');
      const latestLayer2 = findLatestE2eStatus(stateStore);

      const status: ProjectStatus = {
        project_path: stateStore.projectPath,
        mode: 'unset',
        jobs_completed: completed,
        jobs_remaining: Math.max(0, total - completed),
        jobs_blocked: blocked,
        current_job: running[0]?.id,
        elapsed_ms: now - startedAt,
        last_activity: new Date().toISOString(),
      };

      const extras = latestLayer2 ? { latest_e2e_status: latestLayer2 } : {};

      // view="queue" enriches the summary with a cancellable job list. Default
      // (no view, or view="summary") stays byte-identical to the legacy output.
      const queueExtras: Record<string, unknown> = {};
      if (view === 'queue') {
        const statuses = include_blocked ? QUEUE_STATUSES_FULL : QUEUE_STATUSES_DEFAULT;
        const jobs = statuses.flatMap((s) => stateStore.getJobsByStatus(s));
        jobs.sort((a, b) => a.createdAt - b.createdAt);
        const truncated = jobs.length > QUEUE_CAP;
        const heartbeatTimeoutMs = jobManager.getHeartbeatTimeoutMs();
        queueExtras.jobs = (truncated ? jobs.slice(0, QUEUE_CAP) : jobs).map((job) =>
          summarizeJob(job, now, heartbeatTimeoutMs),
        );
        queueExtras.truncated = truncated;
      }

      const updateInfo = await checkForUpdate();
      const base = { ...status, ...extras, ...queueExtras };
      if (updateInfo?.update_available) {
        return jsonResult({
          ...base,
          update_available: updateInfo.latest,
          update_command: updateInfo.update_command,
          current_version: updateInfo.current,
          upgrade_guidance: updateInfo.upgrade_guidance,
          upgrade_steps: updateInfo.upgrade_steps,
        });
      }

      return jsonResult(base);
    },
  );
};
