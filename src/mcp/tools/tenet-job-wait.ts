import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export const registerTenetJobWaitTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_job_wait',
    {
      description:
        'Check the current status of a running job. ' +
        'By default returns instantly with the job state. ' +
        'Use wait_seconds to make the server wait before responding (useful for agents that expect blocking behavior). ' +
        'When is_terminal is true, the job is done — collect results with tenet_job_result.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        cursor: z.string().optional().describe('Event cursor from previous call for incremental updates'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe(
            'Optional: server waits this many seconds before responding. ' +
            'If the job becomes terminal during the wait, returns immediately. ' +
            'Use 0 or omit for instant response. Max 120 seconds.',
          ),
      }),
    },
    async ({ job_id, cursor, wait_seconds }) => {
      const waitMs = (wait_seconds ?? 0) * 1000;

      if (waitMs <= 0) {
        const result = await jobManager.checkJobStatus(job_id, cursor ?? null);
        return jsonResult(result);
      }

      // Poll with short intervals until terminal or timeout
      const deadline = Date.now() + waitMs;
      const pollInterval = 2000; // check every 2 seconds

      while (Date.now() < deadline) {
        const result = await jobManager.checkJobStatus(job_id, cursor ?? null);
        if (result.is_terminal) {
          return jsonResult(result);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return jsonResult(result);
        }
        await sleep(Math.min(pollInterval, remaining));
      }

      // Final check after timeout
      const result = await jobManager.checkJobStatus(job_id, cursor ?? null);
      return jsonResult(result);
    },
  );
};
