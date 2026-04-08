import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetContinueTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_continue',
    {
      description: 'Resume from server tracked continuation state',
      inputSchema: z.object({}),
    },
    async () => jsonResult(jobManager.continue()),
  );
};
