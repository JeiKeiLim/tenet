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

/**
 * List filenames (not contents) from a .tenet subdirectory so agents can selectively read relevant ones.
 * Filenames are self-descriptive dated slugs (e.g. 2026-04-08_auth-middleware-jwt-validation.md).
 */
const listFiles = (dir: string, prefix: string): string => {
  if (!fs.existsSync(dir)) {
    return '';
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) {
    return '';
  }

  return files.map((f) => `- ${prefix}${f}`).join('\n');
};

/**
 * Resolve the latest document matching `$date-$feature.md` in a directory.
 * Files are sorted lexicographically (date prefix ensures chronological order),
 * and the last match (most recent) is returned.
 * Returns empty string if no matches found.
 */
const resolveLatest = (dir: string, feature: string): string => {
  if (!fs.existsSync(dir)) {
    return '';
  }

  const suffix = `-${feature}.md`;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort();

  if (matches.length === 0) {
    return '';
  }

  return fs.readFileSync(path.join(dir, matches[matches.length - 1]), 'utf8');
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
      const feature = typeof job.params.feature === 'string' ? job.params.feature : undefined;

      // Resolve spec: feature-scoped with fallback to old singleton
      const specMd = feature
        ? resolveLatest(path.join(tenetPath, 'spec'), feature)
        : readIfExists(path.join(tenetPath, 'spec', 'spec.md'));

      // Resolve decomposition: own directory (new) or under spec/ (old)
      const decompositionMd = feature
        ? resolveLatest(path.join(tenetPath, 'decomposition'), feature)
        : readIfExists(path.join(tenetPath, 'spec', 'decomposition.md'));

      // Resolve interview: feature-scoped, no old-format fallback
      const interviewMd = feature
        ? resolveLatest(path.join(tenetPath, 'interview'), feature)
        : '';

      // Resolve scenarios: feature-scoped with fallback
      const scenariosMd = feature
        ? resolveLatest(path.join(tenetPath, 'spec'), `scenarios-${feature}`)
            || resolveLatest(path.join(tenetPath, 'spec'), feature.replace(/^scenarios-/, ''))
        : readIfExists(path.join(tenetPath, 'spec', 'scenarios.md'));

      // Project-wide documents (always singular)
      const harnessMd = readIfExists(path.join(tenetPath, 'harness', 'current.md'));
      const statusMd = readIfExists(path.join(tenetPath, 'status', 'status.md'));
      // Steer messages now live in SQLite via tenet_add_steer, but keep reading inbox.md for backward compatibility
      const steerInbox = readIfExists(path.join(tenetPath, 'steer', 'inbox.md'));
      const codebaseScanMd = readIfExists(path.join(tenetPath, 'bootstrap', 'codebase-scan.md'));

      // Knowledge and journal file listings (filenames only — agents read selectively)
      const knowledgeListing = listFiles(path.join(tenetPath, 'knowledge'), '.tenet/knowledge/');
      const journalListing = listFiles(path.join(tenetPath, 'journal'), '.tenet/journal/');

      const jobName = typeof job.params.name === 'string' ? job.params.name : 'unnamed';
      const jobPrompt = typeof job.params.prompt === 'string' ? job.params.prompt : '';
      const jobDeps = Array.isArray(job.params.depends_on) ? (job.params.depends_on as string[]).join(', ') : 'none';

      const compiled = [
        `# Compiled Context`,
        `job_id: ${job.id}`,
        `job_type: ${job.type}`,
        `job_name: ${jobName}`,
        ...(feature ? [`feature: ${feature}`] : []),
        `job_dependencies: ${jobDeps}`,
        '',
        '## Job Assignment',
        jobPrompt,
        '',
        '## Spec',
        specMd,
        '',
        '## Decomposition',
        decompositionMd,
        ...(interviewMd ? ['', '## Interview', interviewMd] : []),
        ...(scenariosMd ? ['', '## Scenarios & Anti-Scenarios', scenariosMd] : []),
        '',
        '## Harness',
        harnessMd,
        ...(knowledgeListing ? ['', '## Available Knowledge Files', 'Read any relevant files below before starting work:', knowledgeListing] : []),
        ...(journalListing ? ['', '## Session Journal', 'Activity log from this session:', journalListing] : []),
        '',
        '## Status',
        statusMd,
        '',
        '## Steer Inbox',
        steerInbox,
        ...(codebaseScanMd ? ['', '## Codebase Scan', codebaseScanMd] : []),
      ].join('\n');

      return jsonResult({ context: compiled });
    },
  );
};
