import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const readIfExists = (filePath: string): string => {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  return fs.readFileSync(filePath, 'utf8');
};

export const registerTenetCompileContextTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_compile_context',
    {
      description: 'Compile bootstrap context for a job',
      inputSchema: z.object({
        job_id: z.string().uuid(),
      }),
    },
    async ({ job_id }) => {
      const job = stateStore.getJob(job_id);
      if (!job) {
        throw new Error(`job not found: ${job_id}`);
      }

      const tenetPath = path.join(stateStore.projectPath, '.tenet');
      const specMd = readIfExists(path.join(tenetPath, 'spec', 'spec.md'));
      const harnessMd = readIfExists(path.join(tenetPath, 'harness', 'current.md'));
      const statusMd = readIfExists(path.join(tenetPath, 'status', 'status.md'));
      const steerInbox = readIfExists(path.join(tenetPath, 'steer', 'inbox.md'));
      const decompositionMd = readIfExists(path.join(tenetPath, 'spec', 'decomposition.md'));
      const codebaseScanMd = readIfExists(path.join(tenetPath, 'bootstrap', 'codebase-scan.md'));

      const jobName = typeof job.params.name === 'string' ? job.params.name : 'unnamed';
      const jobPrompt = typeof job.params.prompt === 'string' ? job.params.prompt : '';
      const jobDeps = Array.isArray(job.params.depends_on) ? (job.params.depends_on as string[]).join(', ') : 'none';

      const compiled = [
        `# Compiled Context`,
        `job_id: ${job.id}`,
        `job_type: ${job.type}`,
        `job_name: ${jobName}`,
        `job_dependencies: ${jobDeps}`,
        '',
        '## Job Assignment',
        jobPrompt,
        '',
        '## spec/spec.md',
        specMd,
        '',
        '## harness/current.md',
        harnessMd,
        '',
        '## spec/decomposition.md',
        decompositionMd,
        '',
        '## status/status.md',
        statusMd,
        '',
        '## steer/inbox.md',
        steerInbox,
        ...(codebaseScanMd ? ['', '## bootstrap/codebase-scan.md', codebaseScanMd] : []),
      ].join('\n');

      return jsonResult({ context: compiled });
    },
  );
};
