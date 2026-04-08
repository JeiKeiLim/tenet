import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetRetryJobTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_retry_job',
    {
      description:
        'Reset a completed or failed job back to pending for re-dispatch. ' +
        'Preserves DAG linkage and increments retry count. ' +
        'Optionally provide an enhanced prompt to replace the original (e.g. add failure context).',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        enhanced_prompt: z
          .string()
          .optional()
          .describe('Replacement prompt with added context about why previous attempt failed'),
      }),
    },
    async ({ job_id, enhanced_prompt }) => {
      const job = jobManager.retryJob(job_id, enhanced_prompt);
      return jsonResult({
        job_id: job.id,
        status: job.status,
        retry_count: job.retryCount,
        max_retries: job.maxRetries,
      });
    },
  );
};
