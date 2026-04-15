import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { checkForUpdate } from '../../core/update-checker.js';
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

      const updateInfo = await checkForUpdate();
      if (updateInfo?.update_available) {
        return jsonResult({
          ...status,
          update_available: updateInfo.latest,
          update_command: updateInfo.update_command,
          current_version: updateInfo.current,
        });
      }

      return jsonResult(status);
    },
  );
};
