import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, jobTypeSchema, type RegisterTool } from './utils.js';

export const registerTenetStartJobTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_start_job',
    {
      description:
        'Dispatch a Tenet job for execution. Either provide job_id to execute a registered job ' +
        '(from tenet_register_jobs/tenet_continue), or provide job_type + params to create and start a new ad-hoc job. ' +
        'For ad-hoc jobs, ALWAYS include a "name" key in params with a human-readable job name (e.g., "fix-login-redirect", "test-critic for job-1").',
      inputSchema: z.object({
        job_id: z.string().uuid().optional().describe('Existing job ID from tenet_continue or tenet_register_jobs'),
        job_type: jobTypeSchema.optional().describe('Job type for ad-hoc jobs: "dev" for implementation, "eval" for evaluation'),
        params: z.record(z.string(), z.unknown()).optional().describe('Params for ad-hoc jobs. Must include "prompt" and "name" keys. Name should be human-readable (e.g., "fix-login-redirect").'),
      }),
    },
    async ({ job_id, job_type, params }) => {
      if (job_id) {
        const job = jobManager.dispatchJob(job_id);
        return jsonResult({ job_id: job.id });
      }

      if (!job_type) {
        throw new Error('Either job_id (for registered jobs) or job_type (for ad-hoc jobs) is required');
      }

      const job = jobManager.startJob(job_type, params ?? {});
      return jsonResult({ job_id: job.id });
    },
  );
};
