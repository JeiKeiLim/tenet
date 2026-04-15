import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { checkForUpdate } from '../../core/update-checker.js';
import type { HealthReport } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetHealthCheckTool = (
  registerTool: RegisterTool,
  stateStore: StateStore,
  jobManager: JobManager,
): void => {
  const startedAt = Date.now();

  registerTool(
    'tenet_health_check',
    {
      description: 'Run document and system health audit',
      inputSchema: z.object({}),
    },
    async () => {
      const activeJobs = stateStore.getActiveJobs().length;
      const report: HealthReport = {
        healthy: true,
        server_uptime_ms: Date.now() - startedAt,
        active_jobs: activeJobs,
        orphaned_files: [],
        stale_documents: [],
        missing_updates: [],
        broken_references: [],
        unacknowledged_steers: stateStore.getUnprocessedSteers().length,
      };

      if (jobManager.getActiveConcurrency() > activeJobs) {
        report.healthy = false;
      }

      const updateInfo = await checkForUpdate();
      if (updateInfo?.update_available) {
        return jsonResult({
          ...report,
          update_available: updateInfo.latest,
          update_command: updateInfo.update_command,
          current_version: updateInfo.current,
        });
      }

      return jsonResult(report);
    },
  );
};
