import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { formatMaxRetries } from '../../core/runtime-config.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetRetryJobTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_retry_job',
    {
      description:
        'Re-run a completed or failed job: resets it to pending and dispatches it ' +
        'immediately (same effect as tenet_start_job on the job id). Preserves DAG linkage ' +
        'and increments retry count. The retry budget may be finite or unlimited, depending ' +
        'on Tenet config. Optionally provide an enhanced prompt to replace the original ' +
        '(e.g. add failure context).',
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
        retry_limit: formatMaxRetries(job.maxRetries),
        next_tool: 'tenet_job_wait',
        next_args: { job_id: job.id, wait_seconds: 30 },
        message: `Job retried and dispatched as ${job.status}. Wait with tenet_job_wait, then fetch terminal output with tenet_job_result.`,
      });
    },
  );
};
