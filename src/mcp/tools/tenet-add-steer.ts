import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetAddSteerTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_add_steer',
    {
      description:
        'Create a steer message in the runtime queue. ' +
        'Use class "context" for informational messages, "directive" for priority/scope changes, ' +
        '"emergency" for immediate halt. ' +
        'Optionally target specific jobs via affected_job_ids — if empty, the message broadcasts to all jobs.',
      inputSchema: z.object({
        content: z.string().min(1).describe('The steer message content'),
        class: z
          .enum(['context', 'directive', 'emergency'])
          .default('context')
          .describe('Message class: context (info), directive (priority change), emergency (halt)'),
        source: z
          .enum(['user', 'agent'])
          .default('agent')
          .describe(
            'Who created this message. "user" for human-originated steers (always higher priority), ' +
            '"agent" for agent-originated steers (e.g., self-unblocking after max retries).',
          ),
        affected_job_ids: z
          .array(z.string())
          .default([])
          .describe(
            'Job IDs this message targets. Empty = broadcast to all. ' +
            'The orchestrator should assign specific job IDs when it knows which jobs need the steer.',
          ),
      }),
    },
    async ({ content, class: msgClass, source, affected_job_ids }) => {
      const steer = stateStore.createSteer({
        class: msgClass,
        content,
        source: source ?? 'agent',
        affectedJobIds: affected_job_ids,
      });

      return jsonResult({
        steer_id: steer.id,
        class: steer.class,
        affected_job_ids: steer.affectedJobIds,
        message: 'Steer message created. It will be picked up at the next tenet_process_steer() checkpoint.',
      });
    },
  );
};
