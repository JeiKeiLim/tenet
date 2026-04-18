import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { checkForUpdate } from '../../core/update-checker.js';
import type { Job, ProjectStatus } from '../../types/index.js';
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

const findLatestPlaywrightLayer2Status = (stateStore: StateStore): string | undefined => {
  // Scan completed playwright_eval jobs in reverse-chronological order
  const completed = stateStore
    .getJobsByStatus('completed' as Job['status'])
    .filter((j) => j.type === 'playwright_eval')
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

  if (completed.length === 0) {
    return undefined;
  }

  const raw = extractRawOutput(stateStore.getJobOutput(completed[0].id));
  const parsed = extractJsonObject(raw);
  const status = parsed?.layer2_status;
  return typeof status === 'string' ? status : undefined;
};

export const registerTenetGetStatusTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  const startedAt = Date.now();

  registerTool(
    'tenet_get_status',
    {
      description:
        'Get high-level project summary status. Also surfaces the most recent Playwright eval layer2_status ' +
        'so callers can distinguish "fully verified" from "passed with Layer 2 skipped".',
      inputSchema: z.object({}),
    },
    async () => {
      const completed = stateStore.getCompletedCount();
      const total = stateStore.getTotalCount();
      const blocked = stateStore.getBlockedJobs().length;
      const running = stateStore.getJobsByStatus('running');
      const latestLayer2 = findLatestPlaywrightLayer2Status(stateStore);

      const status: ProjectStatus = {
        project_path: stateStore.projectPath,
        mode: 'unset',
        jobs_completed: completed,
        jobs_remaining: Math.max(0, total - completed),
        jobs_blocked: blocked,
        current_job: running[0]?.id,
        elapsed_ms: Date.now() - startedAt,
        last_activity: new Date().toISOString(),
      };

      const extras = latestLayer2 ? { latest_playwright_layer2_status: latestLayer2 } : {};

      const updateInfo = await checkForUpdate();
      if (updateInfo?.update_available) {
        return jsonResult({
          ...status,
          ...extras,
          update_available: updateInfo.latest,
          update_command: updateInfo.update_command,
          current_version: updateInfo.current,
        });
      }

      return jsonResult({ ...status, ...extras });
    },
  );
};
