import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, asToolError, type RegisterTool } from './utils.js';

const steerStatusSchema = z.enum(['acknowledged', 'acted_on', 'resolved']);

export const registerTenetUpdateSteerTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_update_steer',
    {
      description:
        'Transition one or more steer messages through their lifecycle (acknowledged / acted_on / resolved), ' +
        'or bulk-sweep agent self-notes. Two mutually exclusive modes:\n' +
        '- `ids`: transition exactly the steers listed. Use this for directives/emergencies once handled, and to retire ' +
        'any steer you want gone. Only the ids you list are touched — a steer you want to keep applying is safe, just ' +
        "leave it out of the list.\n" +
        '- `sweep: "agent_context"`: resolve every agent-originated context steer in one call (the ephemeral pile). ' +
        'Never touches user steers or directives of any source — those retire only by explicit id, so a standing rule ' +
        'or a pending user directive can never be swept away.\n' +
        'Lifetime contract: `context` steers are one-time (retire once consumed); `directive`/`emergency` persist until ' +
        'retired. Add agent self-notes as `context`, not `directive`, so they stay sweepable.',
      inputSchema: z.object({
        ids: z
          .array(z.string().min(1))
          .optional()
          .describe('Steer ids to transition (precise retire). Mutually exclusive with `sweep`.'),
        sweep: z
          .enum(['agent_context'])
          .optional()
          .describe('Bulk-resolve all agent-originated context steers. Mutually exclusive with `ids`.'),
        status: steerStatusSchema.describe('Status to set: acknowledged, acted_on, or resolved.'),
        agent_response: z
          .string()
          .optional()
          .describe('Optional note recorded on each transitioned steer (e.g. reason for resolving).'),
      }),
    },
    async ({ ids, sweep, status, agent_response }) => {
      const hasIds = Array.isArray(ids) && ids.length > 0;
      if (hasIds === Boolean(sweep)) {
        return asToolError(
          new Error('Provide exactly one of `ids` (one or more) or `sweep`. They are mutually exclusive.'),
        );
      }

      if (sweep === 'agent_context') {
        const result = stateStore.sweepAgentContextSteers(status, agent_response);
        return jsonResult({
          swept: result.swept,
          ids: result.ids,
          status,
          message:
            result.swept === 0
              ? 'No agent-context steers to sweep.'
              : `Swept ${result.swept} agent-context steer(s) to "${status}". User steers and directives were not touched.`,
        });
      }

      const result = stateStore.updateSteersStatus(ids as string[], status, agent_response);
      if (result.updated === 0) {
        return asToolError(new Error('No steer matched the given ids. Nothing was transitioned.'));
      }
      return jsonResult({
        updated: result.updated,
        status,
        message: `Transitioned ${result.updated} steer(s) to "${status}".`,
      });
    },
  );
};
