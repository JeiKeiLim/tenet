import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetJobWaitTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_job_wait',
    {
      description:
        'Check the current status of a running job. Returns instantly with the job state. ' +
        'Call this as a BACKGROUND TASK periodically to monitor job progress. ' +
        'When is_terminal is true, the job is done — collect results with tenet_job_result.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        cursor: z.string().optional().describe('Event cursor from previous call for incremental updates'),
      }),
    },
    async ({ job_id, cursor }) => {
      const result = await jobManager.checkJobStatus(job_id, cursor ?? null);
      return jsonResult(result);
    },
  );
};
