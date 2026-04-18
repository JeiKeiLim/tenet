import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const buildRemediationPrompt = (params: {
  reason: string;
  suggestedFix: string;
  targetFiles: string[];
  parentJobName: string;
  feature?: string;
}): string => {
  const sections = [
    '## Remediation Request',
    '',
    `You were spawned by a REPORT-ONLY job ("${params.parentJobName}") that discovered a real bug while verifying its own deliverables. The parent job is paused and will resume after you complete successfully and pass eval.`,
    '',
    '### Why remediation is needed',
    params.reason,
    '',
    '### Suggested fix',
    params.suggestedFix,
    '',
  ];

  if (params.targetFiles.length > 0) {
    sections.push(
      '### Target files (hint — verify before editing)',
      ...params.targetFiles.map((f) => `- ${f}`),
      '',
    );
  }

  sections.push(
    '### Expected outcome',
    '- Implement the fix described above.',
    '- Ensure tests pass (unit + integration).',
    '- Keep the change minimal and scoped to the bug — do NOT refactor unrelated code.',
    '- The parent report-only job will auto-resume once this job completes AND its eval passes.',
  );

  return sections.join('\n');
};

export const registerTenetRequestRemediationTool = (
  registerTool: RegisterTool,
  jobManager: JobManager,
  stateStore: StateStore,
): void => {
  registerTool(
    'tenet_request_remediation',
    {
      description:
        'Called by a REPORT-ONLY job when verification reveals a real bug that must be fixed for its ' +
        'report to be trustworthy. Marks the calling job as blocked_remediation_required and spawns a ' +
        'child dev job with the requested fix. The parent job auto-resumes when the child completes ' +
        'successfully AND its eval passes. Use this INSTEAD of editing files yourself in a report-only ' +
        'context — editing files directly violates report-only scope and fails the critic.',
      inputSchema: z.object({
        job_id: z
          .string()
          .uuid()
          .describe('The ID of the calling report-only job (the one that should be paused).'),
        reason: z.string().min(1).describe('Why remediation is needed — what was observed.'),
        suggested_fix: z
          .string()
          .min(1)
          .describe('What the child dev job should do to resolve the issue.'),
        target_files: z
          .array(z.string())
          .default([])
          .describe('Optional hint for the child job — likely files to edit.'),
      }),
    },
    async ({ job_id, reason, suggested_fix, target_files }) => {
      const job = stateStore.getJob(job_id);
      if (!job) {
        throw new Error(`job not found: ${job_id}`);
      }

      if (job.params.report_only !== true) {
        throw new Error(
          `job ${job_id} is not tagged report_only=true; remediation escape hatch only applies to report-only jobs`,
        );
      }

      const parentName = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
      const feature = typeof job.params.feature === 'string' ? job.params.feature : undefined;
      const files = Array.isArray(target_files) ? target_files : [];

      const childPrompt = buildRemediationPrompt({
        reason,
        suggestedFix: suggested_fix,
        targetFiles: files,
        parentJobName: parentName,
        feature,
      });

      const child = jobManager.startJob('dev', {
        name: `remediation for ${parentName}`,
        prompt: childPrompt,
        remediation_for: job_id,
        ...(feature ? { feature } : {}),
        ...(files.length > 0 ? { target_files: files } : {}),
      });

      stateStore.updateJob(job_id, {
        status: 'blocked_remediation_required',
      });
      stateStore.appendEvent(job_id, 'remediation_requested', {
        child_job_id: child.id,
        reason,
      });

      return jsonResult({
        parent_job_id: job_id,
        child_job_id: child.id,
        parent_status: 'blocked_remediation_required',
        message:
          'Parent job paused. A child dev job has been dispatched to resolve the issue. The parent will auto-resume after the child completes and its eval passes. End your turn now.',
      });
    },
  );
};
