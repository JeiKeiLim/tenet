import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { jsonResult, type RegisterTool } from './utils.js';

const CODE_CRITIC_PREAMBLE = [
  '## Code Critic — Purpose Alignment Check',
  '',
  'You are the CODE CRITIC. You have NO access to the author\'s reasoning or conversation.',
  'You receive ONLY the spec, scenarios, harness, and the code diff.',
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
  'End with: {"passed": true/false, "stage": "code_critic", "findings": ["..."]}',
  '',
  '## Implementation Output',
  '',
].join('\n');

const TEST_CRITIC_PREAMBLE = [
  '## Test Critic — Test Sufficiency Check',
  '',
  'You are the TEST CRITIC. You do NOT review the implementation code.',
  'You receive ONLY the spec, scenarios, and the acceptance/integration test files.',
  '',
  'Your job: determine whether these tests are SUFFICIENT to prove the features actually work.',
  '',
  'For each scenario in the spec, check:',
  '- Is there a test that covers this scenario?',
  '- Does the test verify the CORRECT OUTCOME, not just absence of errors?',
  '  - BAD: "expect no error" / "expect page loads" / "expect status 200"',
  '  - GOOD: "expect redirect to /dashboard" / "expect created item appears in list"',
  '- After login: does the test verify session persistence (reload still authenticated)?',
  '- After create: does the test verify the item is visible in a list/detail view?',
  '- After form submit: does the test verify redirect to the CORRECT destination (not same page)?',
  '',
  'Also check for MISSING coverage:',
  '- Are there routes/pages/endpoints in the codebase that have NO test at all?',
  '- Are there interactive elements (buttons, forms, links) with no test?',
  '- Are there user journeys that span multiple pages with no end-to-end test?',
  '',
  'If tests are insufficient, list SPECIFIC tests that need to be added or strengthened.',
  '',
  'End with: {"passed": true/false, "stage": "test_critic", "findings": ["..."], "missing_tests": ["..."]}',
  '',
  '## Test Files and Spec',
  '',
].join('\n');

export const registerTenetStartEvalTool = (registerTool: RegisterTool, jobManager: JobManager): void => {
  registerTool(
    'tenet_start_eval',
    {
      description:
        'Start evaluation pipeline for a completed job. Dispatches TWO critic jobs: ' +
        '(1) Code critic — independent purpose alignment check (spec + diff only, no author reasoning), ' +
        '(2) Test critic — reviews whether tests are sufficient to prove features work (spec + tests only). ' +
        'Returns both job IDs. Wait for both to complete.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        output: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ job_id, output }) => {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

      // Code critic: gets only the spec + diff, no author reasoning or conversation history
      const codeCriticJob = jobManager.startJob('critic_eval', {
        source_job_id: job_id,
        eval_stage: 'code_critic',
        prompt: CODE_CRITIC_PREAMBLE + outputStr,
        output,
      });

      // Test critic: gets spec + test files, reviews whether tests are sufficient
      const testCriticJob = jobManager.startJob('eval', {
        source_job_id: job_id,
        eval_stage: 'test_critic',
        prompt: TEST_CRITIC_PREAMBLE + outputStr,
        output,
      });

      return jsonResult({
        code_critic_job_id: codeCriticJob.id,
        test_critic_job_id: testCriticJob.id,
        message: 'Code critic and test critic dispatched. Wait for both using tenet_job_wait + tenet_job_result.',
      });
    },
  );
};
