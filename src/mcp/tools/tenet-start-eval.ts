import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetStartEvalTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_start_eval',
    {
      description: 'Start evaluation pipeline as background job',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        output: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ job_id, output }) => {
      const evalJob = jobManager.startJob('eval', {
        source_job_id: job_id,
        output,
      });
      return jsonResult({ job_id: evalJob.id });
    },
  );
};
