import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const buildFollowUpPrompt = (params: {
  finding: string;
  whyItBlocksReport: string;
  recommendedFollowup: string;
  suspectedFiles: string[];
  parentJobName: string;
}): string => {
  const sections = [
    '## Blocking Finding Follow-up',
    '',
    `A REPORT-ONLY job ("${params.parentJobName}") found a blocking issue it is not allowed to fix directly. The report-only parent is paused and will resume after this follow-up job completes successfully and passes eval.`,
    '',
    '### Finding',
    params.finding,
    '',
    '### Why it blocks the report',
    params.whyItBlocksReport,
    '',
    '### Recommended follow-up',
    params.recommendedFollowup,
    '',
  ];

  if (params.suspectedFiles.length > 0) {
    sections.push(
      '### Suspected files (hints only — verify before editing)',
      ...params.suspectedFiles.map((f) => `- ${f}`),
      '',
    );
  }

  sections.push(
    '### Expected outcome',
    '- Investigate the finding and make the minimal scoped code/test/harness change needed to resolve it.',
    '- Run relevant tests and smoke checks.',
    '- Do not edit the report-only parent output directly.',
    '- The report-only parent will run again with fresh context after this job and its evals pass.',
  );

  return sections.join('\n');
};

export const registerTenetReportBlockingFindingTool = (
  registerTool: RegisterTool,
  jobManager: JobManager,
  stateStore: StateStore,
): void => {
  registerTool(
    'tenet_report_blocking_finding',
    {
      description:
        'Called by a REPORT-ONLY job when verification finds a blocking issue it must not fix directly. ' +
        'This pauses the report-only parent as blocked_on_finding and starts a linked dev follow-up job. ' +
        'Use this instead of editing files from report-only scope or starting an unlinked ad-hoc job.',
      inputSchema: z.object({
        job_id: z
          .string()
          .uuid()
          .describe('The ID of the calling report-only job that should pause until the finding is resolved.'),
        finding: z.string().min(1).describe('What was observed. Include concrete failure/evidence.'),
        why_it_blocks_report: z
          .string()
          .min(1)
          .describe('Why the report cannot be trustworthy until this is resolved.'),
        recommended_followup: z
          .string()
          .min(1)
          .describe('What a separate dev follow-up job should investigate or change.'),
        suspected_files: z
          .array(z.string())
          .default([])
          .describe('Optional hints for likely files. These are not exclusive.'),
      }),
    },
    async ({ job_id, finding, why_it_blocks_report, recommended_followup, suspected_files }) => {
      const job = stateStore.getJob(job_id);
      if (!job) {
        throw new Error(`job not found: ${job_id}`);
      }

      if (job.params.report_only !== true) {
        throw new Error(
          `job ${job_id} is not tagged report_only=true; blocking findings can only be reported by report-only jobs`,
        );
      }

      const parentName = typeof job.params.name === 'string' ? job.params.name : job.id.slice(0, 8);
      const feature = typeof job.params.feature === 'string' ? job.params.feature : undefined;
      const files = Array.isArray(suspected_files) ? suspected_files : [];

      const childPrompt = buildFollowUpPrompt({
        finding,
        whyItBlocksReport: why_it_blocks_report,
        recommendedFollowup: recommended_followup,
        suspectedFiles: files,
        parentJobName: parentName,
      });

      const child = jobManager.startJob('dev', {
        name: `blocking finding follow-up for ${parentName}`,
        prompt: childPrompt,
        blocking_finding_for: job_id,
        finding,
        why_it_blocks_report,
        ...(feature ? { feature } : {}),
        ...(files.length > 0 ? { suspected_files: files } : {}),
      });

      stateStore.updateJob(job_id, {
        status: 'blocked_on_finding',
      });
      stateStore.appendEvent(job_id, 'blocking_finding_reported', {
        child_job_id: child.id,
        finding,
      });

      return jsonResult({
        parent_job_id: job_id,
        parent_status: 'blocked_on_finding',
        child_job_id: child.id,
        child_status: child.status,
        next_tool: 'tenet_job_wait',
        next_args: { job_id: child.id, wait_seconds: 30 },
        worker_instruction:
          'Report-only worker: stop report-only work now and do not edit files for this finding.',
        orchestrator_instruction:
          'Orchestrator: wait for the child job, run eval on the child, then continue normally. The parent will return to pending after all child evals pass.',
      });
    },
  );
};
