import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import type { SteerResult } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

export const registerTenetProcessSteerTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_process_steer',
    {
      description: 'Check steer inbox and summarize pending steer state',
      inputSchema: z.object({}),
    },
    async () => {
      const messages = stateStore.getUnprocessedSteers();
      const result: SteerResult = {
        has_emergency: messages.some((message) => message.class === 'emergency'),
        has_directive: messages.some((message) => message.class === 'directive'),
        messages,
      };
      return jsonResult(result);
    },
  );
};
