import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetJobResultTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_job_result',
    {
      description: 'Fetch full result payload for a job',
      inputSchema: z.object({
        job_id: z.string().uuid(),
      }),
    },
    async ({ job_id }) => jsonResult(jobManager.getJobResult(job_id)),
  );
};
