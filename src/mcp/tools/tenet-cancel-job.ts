import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { okResult, type RegisterTool } from './utils.js';

export const registerTenetCancelJobTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_cancel_job',
    {
      description: 'Cancel a running or pending job',
      inputSchema: z.object({
        job_id: z.string().uuid(),
      }),
    },
    async ({ job_id }) => {
      jobManager.cancelJob(job_id);
      return okResult();
    },
  );
};
