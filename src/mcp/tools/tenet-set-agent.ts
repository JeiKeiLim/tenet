import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { okResult, parseJobType, type RegisterTool } from './utils.js';

export const registerTenetSetAgentTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_set_agent',
    {
      description:
        'Change the default agent or override agent for a specific job type. ' +
        'Available agents: claude-code, opencode, codex. ' +
        'Omit job_type to change the global default.',
      inputSchema: z.object({
        agent_name: z.string().min(1).describe('Agent adapter name: claude-code, opencode, or codex'),
        job_type: z.string().optional().describe('Job type to override (omit to set global default)'),
      }),
    },
    async ({ agent_name, job_type }) => {
      if (job_type) {
        const parsedType = parseJobType(job_type);
        stateStore.setConfig(`agent_override_${parsedType}`, agent_name);
      } else {
        stateStore.setConfig('default_agent', agent_name);
      }
      return okResult();
    },
  );
};
