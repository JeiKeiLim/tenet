import { z } from 'zod';
import { parseMaxRetries } from '../../core/runtime-config.js';
import { StateStore } from '../../core/state-store.js';
import { artifactPathsSchema, normalizeArtifactPaths, type ArtifactPaths } from './artifact-paths.js';
import { jsonResult, type RegisterTool } from './utils.js';

const jobEntrySchema = z.object({
  id: z.string().min(1).describe('Job ID matching the decomposition DAG (e.g. "job-1", "job-2")'),
  name: z.string().min(1).describe('Human-readable job name'),
  type: z.enum(['dev', 'integration_test']).default('dev').describe('Job type: "dev" for implementation, "integration_test" for checkpoint tests'),
  depends_on: z.array(z.string()).default([]).describe('IDs of jobs this depends on'),
  prompt: z.string().min(1).describe('Work description for the agent executing this job'),
  report_only: z
    .boolean()
    .optional()
    .describe(
      'If true, the job produces an assessment/report only and MUST NOT edit project files. ' +
        'Use tenet_report_blocking_finding to escalate blocking issues discovered during verification. ' +
        'Typical cases: final acceptance sweeps, architectural reviews, drift audits.',
    ),
});

export const registerTenetRegisterJobsTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_register_jobs',
    {
      description:
        'Register jobs from the decomposition DAG into the runtime queue. ' +
        'Call once per decomposition fire — once per feature in autonomous mode (delivery_mode: autonomous), ' +
        'once per slice in agile mode (delivery_mode: agile). ' +
        'Each job becomes a pending SQLite entry that tenet_continue() can return.',
      inputSchema: z.object({
        feature: z.string().min(1).describe('Feature slug (e.g. "oauth", "payments"). Used to resolve spec/decomposition docs.'),
        artifact_paths: artifactPathsSchema
          .optional()
          .describe(
            'Exact project-relative or absolute paths for current-run artifacts. ' +
              'Recommended: include spec, harness, scenarios, interview, and decomposition. ' +
              'If omitted, jobs fall back to strict feature filename resolution and the response includes a warning.',
          ),
        jobs: z.array(jobEntrySchema).min(1).describe('Array of jobs from the decomposition DAG'),
      }),
    },
    async ({ feature, artifact_paths, jobs }) => {
      const dagIdToDbId = new Map<string, string>();
      const resolvedArtifactPaths: ArtifactPaths | undefined = artifact_paths
        ? normalizeArtifactPaths(
            stateStore.projectPath,
            artifact_paths,
            ['spec', 'harness', 'decomposition'],
            ['scenarios', 'interview'],
          )
        : undefined;

      const maxRetries = parseMaxRetries(stateStore.getConfig('max_retries'));

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
            ...(resolvedArtifactPaths ? { artifact_paths: resolvedArtifactPaths } : {}),
            ...(entry.report_only === true ? { report_only: true } : {}),
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
        ...(resolvedArtifactPaths
          ? { artifact_paths: resolvedArtifactPaths }
          : {
              warning:
                'artifact_paths was not provided; registered jobs will use strict feature filename fallback in compile_context. Pass exact artifact_paths to avoid stale document selection.',
            }),
      });
    },
  );
};
