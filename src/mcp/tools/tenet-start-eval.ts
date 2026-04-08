import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

const AUTHOR_EVAL_PREAMBLE = [
  '## Author Eval — Spec Compliance Check',
  '',
  'You are the AUTHOR evaluator. You have access to the full implementation context.',
  'Check whether the implementation meets the spec requirements:',
  '- Are all acceptance criteria from the spec met?',
  '- Are all deliverables from the decomposition present?',
  '- Does the code match the documented design?',
  '',
  'Output a checklist with pass/fail per criterion.',
  'End with: {"passed": true/false, "stage": "author", "findings": ["..."]}',
  '',
  '## Implementation Output',
  '',
].join('\n');

const CRITIC_EVAL_PREAMBLE = [
  '## Critic Eval — Purpose Alignment Check',
  '',
  'You are the CRITIC evaluator. You have NO access to the author\'s reasoning or conversation.',
  'You receive ONLY the spec, scenarios, harness, and the implementation output.',
  '',
  'Check independently:',
  '- Does the implementation match the spec\'s intent?',
  '- Are any anti-scenarios violated?',
  '- Are there obvious gaps or missing edge cases?',
  '',
  'ZERO-FINDINGS RULE: If you find nothing wrong, you MUST re-analyze from an alternate',
  'attack angle (security, performance, concurrency, error handling). Zero findings on',
  'first pass triggers a mandatory second pass.',
  '',
  'Then perform structured self-questioning:',
  '- Edge cases: empty input, max values, unicode?',
  '- Error paths: dependency failures, timeouts?',
  '- Integration: does this break upstream/downstream?',
  '- Security: input validation, secret exposure, injection?',
  '- Performance: N+1 queries, unbounded loops, memory leaks?',
  '',
  'End with: {"passed": true/false, "stage": "critic", "findings": ["..."]}',
  '',
  '## Implementation Output',
  '',
].join('\n');

export const registerTenetStartEvalTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_start_eval',
    {
      description:
        'Start evaluation pipeline for a completed job. Dispatches TWO eval jobs: ' +
        '(1) Author eval — spec compliance check with full context, ' +
        '(2) Critic eval — independent purpose alignment check without author reasoning. ' +
        'Returns both job IDs. Wait for both to complete.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        output: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ job_id, output }) => {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

      // Author eval: has full context including the output and implementation reasoning
      const authorJob = jobManager.startJob('eval', {
        source_job_id: job_id,
        eval_stage: 'author',
        prompt: AUTHOR_EVAL_PREAMBLE + outputStr,
        output,
      });

      // Critic eval: gets only the output, no author reasoning or conversation history
      const criticJob = jobManager.startJob('critic_eval', {
        source_job_id: job_id,
        eval_stage: 'critic',
        prompt: CRITIC_EVAL_PREAMBLE + outputStr,
        output,
      });

      return jsonResult({
        author_eval_job_id: authorJob.id,
        critic_eval_job_id: criticJob.id,
        message: 'Author and critic eval dispatched. Wait for both using tenet_job_wait + tenet_job_result.',
      });
    },
  );
};
