import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import type { SteerResult } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetProcessSteerTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_process_steer',
    {
      description:
        'Check steer inbox and summarize pending steer state. ' +
        'Optionally filter by job_id to get only messages targeted at (or broadcast to) a specific job.',
      inputSchema: z.object({
        job_id: z.string().uuid().optional().describe('Optional job ID to filter messages for a specific job'),
      }),
    },
    async ({ job_id }) => {
      const messages = stateStore.getUnprocessedSteers(job_id);
      const result: SteerResult = {
        has_emergency: messages.some((message) => message.class === 'emergency'),
        has_directive: messages.some((message) => message.class === 'directive'),
        messages,
      };
      return jsonResult(result);
    },
  );
};
