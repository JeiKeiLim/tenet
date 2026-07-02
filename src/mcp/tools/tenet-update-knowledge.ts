import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { toProjectRelativePath } from '../../core/artifact-paths.js';
import { jsonResult, type RegisterTool } from './utils.js';

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const datePrefix = (): string => new Date().toISOString().slice(0, 10);

const getRunPath = (stateStore: StateStore, jobId: string): string | undefined => {
  const job = stateStore.getJob(jobId);
  if (!job || typeof job.params.run_path !== 'string') {
    return undefined;
  }

  try {
    return toProjectRelativePath(stateStore.projectPath, job.params.run_path, 'job.params.run_path');
  } catch {
    return undefined;
  }
};

export const registerTenetUpdateKnowledgeTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_update_knowledge',
    {
      description:
        'Write findings into .tenet/knowledge/ or the appropriate journal directory as a markdown file. ' +
        'Use type="knowledge" for reusable technical wisdom (e.g., "bubbletea height measurement requires terminal resize listener"). ' +
        'Use type="journal" for activity logs and job completion summaries; jobs with run_path write under .tenet/runs/<run>/journal/, legacy jobs write .tenet/journal/. ' +
        'The title becomes the filename (slugified with date prefix). The response file is project-relative.',
      inputSchema: z.object({
        title: z.string().min(3).describe('Short descriptive title for the entry (3-8 words)'),
        job_id: z.string().uuid(),
        findings: z.record(z.string(), z.unknown()),
        type: z.enum(['knowledge', 'journal']).default('journal').describe(
          'Entry type. "knowledge" = reusable technical wisdom that helps future agents working on similar features. ' +
          '"journal" = activity log, job completion summary, or session progress notes. Defaults to "journal".'
        ),
        confidence: z.enum([
          'implemented-and-tested',
          'implemented-not-tested',
          'decision-only',
          'scanned-not-verified',
        ]).optional().describe('Confidence tag for downstream weighting. Defaults to "decision-only". Only relevant for knowledge type.'),
      }),
    },
    async ({ title, job_id, findings, type, confidence }) => {
      const entryType = type ?? 'journal';
      const confidenceTag = confidence ?? 'decision-only';
      const runPath = entryType === 'journal' ? getRunPath(stateStore, job_id) : undefined;
      const outputDirRelative = entryType === 'knowledge'
        ? path.join('.tenet', 'knowledge')
        : runPath
          ? path.join(runPath, 'journal')
          : path.join('.tenet', 'journal');
      const outputDir = path.join(stateStore.projectPath, outputDirRelative);
      fs.mkdirSync(outputDir, { recursive: true });

      const slug = slugify(title);
      const filename = `${datePrefix()}_${slug}.md`;
      const filePath = path.join(outputDir, filename);
      const projectRelativeFile = path
        .relative(stateStore.projectPath, filePath)
        .split(path.sep)
        .join(path.posix.sep);

      const job = stateStore.getJob(job_id);
      const jobName = job ? (typeof job.params.name === 'string' ? job.params.name : job.type) : 'unknown';

      const findingsYaml = Object.entries(findings)
        .map(([key, value]) => `- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join('\n');

      const content = [
        `# ${title}`,
        '',
        `type: ${entryType}`,
        `source_job: ${job_id}`,
        `job_name: ${jobName}`,
        ...(entryType === 'knowledge' ? [`confidence: ${confidenceTag}`] : []),
        `created: ${new Date().toISOString()}`,
        '',
        '## Findings',
        '',
        findingsYaml,
        '',
      ].join('\n');

      fs.writeFileSync(filePath, content, 'utf8');
      return jsonResult({ file: projectRelativeFile, filename });
    },
  );
};
