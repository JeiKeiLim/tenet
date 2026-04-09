import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const datePrefix = (): string => new Date().toISOString().slice(0, 10);

export const registerTenetUpdateKnowledgeTool = (registerTool: RegisterTool, stateStore: StateStore): void => {
  registerTool(
    'tenet_update_knowledge',
    {
      description:
        'Write findings into .tenet/knowledge/ or .tenet/journal/ as a markdown file. ' +
        'Use type="knowledge" for reusable technical wisdom (e.g., "bubbletea height measurement requires terminal resize listener"). ' +
        'Use type="journal" for activity logs and job completion summaries. ' +
        'The title becomes the filename (slugified with date prefix).',
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
      const subdir = entryType === 'knowledge' ? 'knowledge' : 'journal';
      const knowledgeDir = path.join(stateStore.projectPath, '.tenet', subdir);
      fs.mkdirSync(knowledgeDir, { recursive: true });

      const slug = slugify(title);
      const filename = `${datePrefix()}_${slug}.md`;
      const filePath = path.join(knowledgeDir, filename);

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
      return jsonResult({ file: filename });
    },
  );
};
