import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
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

      return jsonResult(report);
    },
  );
};
