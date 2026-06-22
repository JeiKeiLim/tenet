import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import type { SteerResult } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

const DEFAULT_STEER_AGENT_LIMIT = 50;

export const registerTenetProcessSteerTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_process_steer',
    {
      description:
        'Check the steer inbox and summarize pending steer state, split by source. ' +
        'User steers (from the human) are returned in full; agent self-steers are capped to the most recent `limit` ' +
        'so agent noise can never crowd out user input or flood context. ' +
        '`total_unresolved` shows the true count per source even when the agent bucket is capped, and `truncated` ' +
        'signals there are more agent steers than returned — widen `limit` for a deliberate cleanup pass. ' +
        'Retire steers you have handled with `tenet_update_steer`. ' +
        'Optionally filter by job_id to get only messages targeted at (or broadcast to) a specific job.',
      inputSchema: z.object({
        job_id: z
          .string()
          .uuid()
          .optional()
          .describe('Optional job ID to filter messages for a specific job'),
        limit: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_STEER_AGENT_LIMIT)
          .describe(
            'Max agent self-steers returned. User steers are always returned in full. Default 50; widen for a cleanup pass.',
          ),
      }),
    },
    async ({ job_id, limit }) => {
      const inbox = stateStore.getSteerInbox({ jobId: job_id, agentLimit: limit });
      const all = [...inbox.userMessages, ...inbox.agentMessages];
      const returnedAgent = inbox.agentMessages.length;
      const result: SteerResult = {
        has_emergency: all.some((message) => message.class === 'emergency'),
        has_directive: all.some((message) => message.class === 'directive'),
        user_messages: inbox.userMessages,
        agent_messages: inbox.agentMessages,
        total_unresolved: inbox.totals,
        returned: { user: inbox.userMessages.length, agent: returnedAgent },
        truncated: inbox.totals.agent > returnedAgent,
      };
      return jsonResult(result);
    },
  );
};
