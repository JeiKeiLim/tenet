import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import type { ProjectStatus } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetGetStatusTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  const startedAt = Date.now();

  registerTool(
    'tenet_get_status',
    {
      description: 'Get high-level project summary status',
      inputSchema: z.object({}),
    },
    async () => {
      const completed = stateStore.getCompletedCount();
      const total = stateStore.getTotalCount();
      const blocked = stateStore.getBlockedJobs().length;
      const running = stateStore.getJobsByStatus('running');

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

      return jsonResult(status);
    },
  );
};
