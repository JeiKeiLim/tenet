import type { McpServer } from '@modelcontextprotocol/server';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { registerTenetCancelJobTool } from './tenet-cancel-job.js';
import { registerTenetCompileContextTool } from './tenet-compile-context.js';
import { registerTenetContinueTool } from './tenet-continue.js';
import { registerTenetGetStatusTool } from './tenet-get-status.js';
import { registerTenetHealthCheckTool } from './tenet-health-check.js';
import { registerTenetInitTool } from './tenet-init.js';
import { registerTenetJobResultTool } from './tenet-job-result.js';
import { registerTenetJobWaitTool } from './tenet-job-wait.js';
import { registerTenetProcessSteerTool } from './tenet-process-steer.js';
import { registerTenetRegisterJobsTool } from './tenet-register-jobs.js';
import { registerTenetRetryJobTool } from './tenet-retry-job.js';
import { registerTenetSetAgentTool } from './tenet-set-agent.js';
import { registerTenetStartEvalTool } from './tenet-start-eval.js';
import { registerTenetStartJobTool } from './tenet-start-job.js';
import { registerTenetUpdateKnowledgeTool } from './tenet-update-knowledge.js';
import { registerTenetValidateClarityTool } from './tenet-validate-clarity.js';
import { asToolError } from './utils.js';

export const registerAllTools = (server: McpServer, jobManager: JobManager, stateStore: StateStore): void => {
  const registerTool = server.registerTool.bind(server);

  const safeRegister = (registerFn: () => void): void => {
    try {
      registerFn();
    } catch (error) {
      const fallbackName = `tenet_internal_error_${Date.now()}`;
      registerTool(
        fallbackName,
        {
          description: 'Internal registration error fallback',
        },
        async () => asToolError(error),
      );
    }
  };

  safeRegister(() => registerTenetInitTool(registerTool));
  safeRegister(() => registerTenetContinueTool(registerTool, jobManager));
  safeRegister(() => registerTenetCompileContextTool(registerTool, stateStore));
  safeRegister(() => registerTenetStartJobTool(registerTool, jobManager));
  safeRegister(() => registerTenetJobWaitTool(registerTool, jobManager));
  safeRegister(() => registerTenetJobResultTool(registerTool, jobManager));
  safeRegister(() => registerTenetCancelJobTool(registerTool, jobManager));
  safeRegister(() => registerTenetStartEvalTool(registerTool, jobManager));
  safeRegister(() => registerTenetUpdateKnowledgeTool(registerTool, stateStore));
  safeRegister(() => registerTenetProcessSteerTool(registerTool, stateStore));
  safeRegister(() => registerTenetHealthCheckTool(registerTool, stateStore, jobManager));
  safeRegister(() => registerTenetGetStatusTool(registerTool, stateStore));
  safeRegister(() => registerTenetSetAgentTool(registerTool, stateStore));
  safeRegister(() => registerTenetRegisterJobsTool(registerTool, stateStore));
  safeRegister(() => registerTenetRetryJobTool(registerTool, jobManager));
  safeRegister(() => registerTenetValidateClarityTool(registerTool, jobManager, stateStore));
};
