import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { StateStore } from '../../core/state-store.js';
import {
  readArtifactFile,
  resolveLatestFeatureDoc,
  resolveLatestScenariosDoc,
  toProjectRelativePath,
  type ArtifactPaths,
} from './artifact-paths.js';
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

  const files: string[] = [];
  const walk = (currentDir: string, relativePrefix = ''): void => {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativeName = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relativeName);
      } else if (entry.isFile()) {
        files.push(relativeName);
      }
    }
  };

  walk(dir);
  if (files.length === 0) {
    return '';
  }

  return files.map((f) => `- ${prefix}${f}`).join('\n');
};

const readLatestFeatureDoc = (dir: string, feature: string): string => {
  const docPath = resolveLatestFeatureDoc(dir, feature);
  return docPath ? fs.readFileSync(docPath, 'utf8') : '';
};

const readLatestScenariosDoc = (dir: string, feature: string): string => {
  const docPath = resolveLatestScenariosDoc(dir, feature);
  return docPath ? fs.readFileSync(docPath, 'utf8') : '';
};

const getArtifactPaths = (value: unknown): ArtifactPaths | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as ArtifactPaths;
};

const normalizeOptionalProjectRelativePath = (
  projectPath: string,
  value: unknown,
  label: string,
): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return toProjectRelativePath(projectPath, value, label);
  } catch {
    return undefined;
  }
};

const archiveHasEvidence = (archivePath: string): boolean => {
  if (!fs.existsSync(archivePath)) {
    return false;
  }

  return fs.readdirSync(archivePath).some((entry) => !entry.startsWith('.'));
};

const readArtifactOrFallback = (
  projectPath: string,
  artifactPaths: ArtifactPaths | undefined,
  key: keyof ArtifactPaths,
  label: string,
  fallback: () => string,
): string => {
  if (!artifactPaths) {
    return fallback();
  }

  if (!(key in artifactPaths)) {
    if (key === 'spec' || key === 'harness' || key === 'decomposition') {
      throw new Error(`artifact_paths.${key} is missing from job context`);
    }

    return '';
  }

  const artifactPath = artifactPaths[key];
  if (artifactPath == null) {
    return '';
  }

  return readArtifactFile(projectPath, artifactPath, label);
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
      const runSlug = typeof job.params.run_slug === 'string' ? job.params.run_slug : undefined;
      const runPath = normalizeOptionalProjectRelativePath(stateStore.projectPath, job.params.run_path, 'job.params.run_path');
      const artifactPaths = getArtifactPaths(job.params.artifact_paths);

      // Resolve spec: feature-scoped with fallback to old singleton
      const specMd = readArtifactOrFallback(
        stateStore.projectPath,
        artifactPaths,
        'spec',
        'artifact_paths.spec',
        () =>
          feature
            ? readLatestFeatureDoc(path.join(tenetPath, 'spec'), feature)
            : readIfExists(path.join(tenetPath, 'spec', 'spec.md')),
      );

      // Resolve decomposition: own directory (new) or under spec/ (old)
      const decompositionMd = readArtifactOrFallback(
        stateStore.projectPath,
        artifactPaths,
        'decomposition',
        'artifact_paths.decomposition',
        () =>
          feature
            ? readLatestFeatureDoc(path.join(tenetPath, 'decomposition'), feature)
            : readIfExists(path.join(tenetPath, 'spec', 'decomposition.md')),
      );

      // Resolve interview: feature-scoped, no old-format fallback
      const interviewMd = readArtifactOrFallback(
        stateStore.projectPath,
        artifactPaths,
        'interview',
        'artifact_paths.interview',
        () => (feature ? readLatestFeatureDoc(path.join(tenetPath, 'interview'), feature) : ''),
      );

      // Resolve scenarios: feature-scoped with fallback
      const scenariosMd = readArtifactOrFallback(
        stateStore.projectPath,
        artifactPaths,
        'scenarios',
        'artifact_paths.scenarios',
        () =>
          feature
            ? readLatestScenariosDoc(path.join(tenetPath, 'spec'), feature)
            : readIfExists(path.join(tenetPath, 'spec', 'scenarios.md')),
      );

      // Run-local harness (or legacy project-wide harness fallback)
      const harnessMd = readArtifactOrFallback(
        stateStore.projectPath,
        artifactPaths,
        'harness',
        'artifact_paths.harness',
        () => readIfExists(path.join(tenetPath, 'harness', 'current.md')),
      );

      const projectDocs = [
        ['Project Overview', 'project/overview.md'],
        ['Project Architecture', 'project/architecture.md'],
        ['Project Product', 'project/product.md'],
        ['Project Testing', 'project/testing.md'],
        ['Project Design', 'project/design.md'],
      ]
        .map(([heading, relativePath]) => {
          const content = readIfExists(path.join(tenetPath, relativePath));
          return content ? ['', `## ${heading}`, content] : [];
        })
        .flat();

      // Knowledge and evidence listings (filenames only — agents read selectively)
      const knowledgeListing = listFiles(path.join(tenetPath, 'knowledge'), '.tenet/knowledge/');
      const designComponentListing = listFiles(
        path.join(tenetPath, 'project', 'design-components'),
        '.tenet/project/design-components/',
      );
      const runJournalListing = runPath
        ? listFiles(path.join(stateStore.projectPath, runPath, 'journal'), `${runPath}/journal/`)
        : '';
      const runResearchListing = runPath
        ? listFiles(path.join(stateStore.projectPath, runPath, 'research'), `${runPath}/research/`)
        : '';
      const runVisualsListing = runPath
        ? listFiles(path.join(stateStore.projectPath, runPath, 'visuals'), `${runPath}/visuals/`)
        : '';
      const legacyJournalListing = !runPath
        ? listFiles(path.join(tenetPath, 'journal'), '.tenet/journal/')
        : '';
      const hasArchive = archiveHasEvidence(path.join(tenetPath, 'archive'));

      const jobName = typeof job.params.name === 'string' ? job.params.name : 'unnamed';
      const jobPrompt = typeof job.params.prompt === 'string' ? job.params.prompt : '';
      const jobDeps = Array.isArray(job.params.depends_on) ? (job.params.depends_on as string[]).join(', ') : 'none';
      const reportOnly = job.params.report_only === true;

      const reportOnlyPreamble = reportOnly
        ? [
            '',
            '## Report-Only Scope',
            '',
            'You are in REPORT-ONLY mode. You MUST NOT edit project files (other than writing your final report).',
            '',
            'If verification reveals a blocking finding that must be resolved before this report can be trustworthy:',
            '',
            `1. Call \`tenet_report_blocking_finding({ job_id: "${job.id}", finding, why_it_blocks_report, recommended_followup, suspected_files })\`.`,
            '2. Your job will be paused (status: blocked_on_finding).',
            '3. A linked child dev job will investigate/resolve the finding and pass its own evals.',
            '4. Your job will auto-resume with fresh context once the finding is resolved.',
            '',
            'Do NOT edit files yourself. Do NOT silently work around the bug. Do NOT abandon the report.',
            '',
          ].join('\n')
        : '';

      const compiled = [
        `# Compiled Context`,
        `job_id: ${job.id}`,
        `job_type: ${job.type}`,
        `job_name: ${jobName}`,
        ...(feature ? [`feature: ${feature}`] : []),
        ...(runSlug ? [`run_slug: ${runSlug}`] : []),
        ...(runPath ? [`run_path: ${runPath}`] : []),
        ...(artifactPaths ? [`artifact_paths: ${JSON.stringify(artifactPaths)}`] : []),
        `job_dependencies: ${jobDeps}`,
        ...(reportOnly ? ['report_only: true'] : []),
        reportOnlyPreamble,
        '## Job Assignment',
        jobPrompt,
        ...projectDocs,
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
        ...(designComponentListing
          ? ['', '## Project Design Component Files', 'Read relevant accepted examples before changing user-facing surfaces:', designComponentListing]
          : []),
        ...(runJournalListing ? ['', '## Run Journal Files', 'Read selectively for current-run history:', runJournalListing] : []),
        ...(runResearchListing ? ['', '## Run Research Files', 'Read selectively for current-run research:', runResearchListing] : []),
        ...(runVisualsListing ? ['', '## Run Visual Files', 'Inspect selectively for current-run visual direction:', runVisualsListing] : []),
        ...(legacyJournalListing
          ? ['', '## Legacy Session Journal Files', 'Compatibility listing for jobs without run_path:', legacyJournalListing]
          : []),
        ...(hasArchive
          ? ['', '## Archived Legacy Evidence', 'Archived legacy Tenet evidence exists under `.tenet/archive/`. It is not inlined by default; inspect it only for explicit history, migration, or provenance work.']
          : []),
        ...(!artifactPaths
          ? ['', '## Compatibility Notice', 'This job did not carry exact artifact_paths. Tenet used strict legacy feature filename fallback where possible; new runs should register exact run-local artifact_paths.']
          : []),
      ].join('\n');

      return jsonResult({ context: compiled });
    },
  );
};
