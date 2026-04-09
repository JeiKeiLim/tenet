import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const jobEntrySchema = z.object({
  id: z.string().min(1).describe('Job ID matching the decomposition DAG (e.g. "job-1", "job-2")'),
  name: z.string().min(1).describe('Human-readable job name'),
  type: z.enum(['dev', 'integration_test']).default('dev').describe('Job type: "dev" for implementation, "integration_test" for checkpoint tests'),
  depends_on: z.array(z.string()).default([]).describe('IDs of jobs this depends on'),
  prompt: z.string().min(1).describe('Work description for the agent executing this job'),
});

export const registerTenetRegisterJobsTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_register_jobs',
    {
      description:
        'Register all jobs from the decomposition DAG into the runtime queue. ' +
        'Call this ONCE after writing decomposition.md and job-queue.md. ' +
        'Each job becomes a pending SQLite entry that tenet_continue() can return.',
      inputSchema: z.object({
        feature: z.string().min(1).describe('Feature slug (e.g. "oauth", "payments"). Used to resolve spec/decomposition docs.'),
        jobs: z.array(jobEntrySchema).min(1).describe('Array of jobs from the decomposition DAG'),
      }),
    },
    async ({ feature, jobs }) => {
      const dagIdToDbId = new Map<string, string>();

      const configuredRetries = stateStore.getConfig('max_retries');
      const maxRetries = configuredRetries ? Math.max(0, Number.parseInt(configuredRetries, 10) || 3) : 3;

      for (const entry of jobs) {
        const job = stateStore.createJob({
          type: entry.type ?? 'dev',
          status: 'pending',
          params: {
            dag_id: entry.id,
            name: entry.name,
            prompt: entry.prompt,
            depends_on: entry.depends_on,
            feature,
          },
          retryCount: 0,
          maxRetries,
        });
        dagIdToDbId.set(entry.id, job.id);
      }

      // SQLite parent_job_id is single FK; full DAG deps are stored in params.depends_on.
      // getNextRunnableJob() uses parent_job_id to gate execution order.
      for (const entry of jobs) {
        if (entry.depends_on.length === 0) {
          continue;
        }

        const dbId = dagIdToDbId.get(entry.id);
        if (!dbId) {
          continue;
        }

        const parentDagId = entry.depends_on[0];
        const parentDbId = dagIdToDbId.get(parentDagId);
        if (parentDbId) {
          stateStore.updateJob(dbId, { parentJobId: parentDbId });
        }
      }

      const registered = Array.from(dagIdToDbId.entries()).map(([dagId, dbId]) => ({
        dag_id: dagId,
        db_id: dbId,
      }));

      return jsonResult({
        registered_count: registered.length,
        jobs: registered,
      });
    },
  );
};
