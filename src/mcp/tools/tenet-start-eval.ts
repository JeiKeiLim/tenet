import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const buildJobScopeSection = (stateStore: StateStore, jobId: string): string => {
  const job = stateStore.getJob(jobId);
  if (!job) {
    return '';
  }

  const name = typeof job.params.name === 'string' ? job.params.name : 'unknown';
  const dagId = typeof job.params.dag_id === 'string' ? job.params.dag_id : '';
  const prompt = typeof job.params.prompt === 'string' ? job.params.prompt : '';

  return [
    '## Job Scope (evaluate ONLY against this scope)',
    '',
    `**Job**: ${dagId ? `${dagId} — ` : ''}${name}`,
    `**Deliverables**: ${prompt}`,
    '',
    'CRITICAL: Only evaluate work that falls within THIS job\'s scope above.',
    'Features, tests, or capabilities assigned to OTHER jobs in the DAG are OUT OF SCOPE.',
    'Do NOT fail this job for missing functionality that belongs to a later job.',
    '',
  ].join('\n');
};

const CODE_CRITIC_PREAMBLE = [
  '## Code Critic — Purpose Alignment Check',
  '',
  'You are the CODE CRITIC. You have NO access to the author\'s reasoning or conversation.',
  'You receive ONLY the spec, scenarios, harness, and the code diff.',
  '',
  'Check independently:',
  '- Does the implementation match the spec\'s intent FOR THIS JOB\'S SCOPE?',
  '- Are any anti-scenarios violated?',
  '- Are there obvious gaps or missing edge cases WITHIN THIS JOB\'S SCOPE?',
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
].join('\n');

const TEST_CRITIC_PREAMBLE = [
  '## Test Critic — Test Sufficiency Check',
  '',
  'You are the TEST CRITIC. You do NOT review the implementation code.',
  'You receive ONLY the spec, scenarios, and the acceptance/integration test files.',
  '',
  'Your job: determine whether these tests are SUFFICIENT to prove the features',
  'IN THIS JOB\'S SCOPE actually work. Do NOT fail for missing tests that cover',
  'features assigned to later jobs.',
  '',
  'For each scenario IN THIS JOB\'S SCOPE, check:',
  '- Is there a test that covers this scenario?',
  '- Does the test verify the CORRECT OUTCOME, not just absence of errors?',
  '  - BAD: "expect no error" / "expect page loads" / "expect status 200"',
  '  - GOOD: "expect redirect to /dashboard" / "expect created item appears in list"',
  '- After login: does the test verify session persistence (reload still authenticated)?',
  '- After create: does the test verify the item is visible in a list/detail view?',
  '- After form submit: does the test verify redirect to the CORRECT destination (not same page)?',
  '',
  'Also check for MISSING coverage WITHIN THIS JOB\'S SCOPE:',
  '- Are there routes/pages/endpoints built by this job that have NO test at all?',
  '- Are there interactive elements (buttons, forms, links) added by this job with no test?',
  '',
  'If tests are insufficient, list SPECIFIC tests that need to be added or strengthened.',
  '',
  'End with: {"passed": true/false, "stage": "test_critic", "findings": ["..."], "missing_tests": ["..."]}',
  '',
].join('\n');

export const registerTenetStartEvalTool = (registerTool: RegisterTool, jobManager: JobManager, stateStore: StateStore): void => {
  registerTool(
    'tenet_start_eval',
    {
      description:
        'Start evaluation pipeline for a completed job. Dispatches TWO critic jobs: ' +
        '(1) Code critic — independent purpose alignment check (spec + diff only, no author reasoning), ' +
        '(2) Test critic — reviews whether tests are sufficient to prove features work (spec + tests only). ' +
        'Critics evaluate ONLY against the specific job\'s scope, not the full spec. ' +
        'Returns both job IDs. Wait for both to complete.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        output: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ job_id, output }) => {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      const jobScope = buildJobScopeSection(stateStore, job_id);

      // Code critic: gets job scope + spec + diff, no author reasoning or conversation history
      const codeCriticJob = jobManager.startJob('critic_eval', {
        source_job_id: job_id,
        eval_stage: 'code_critic',
        prompt: jobScope + CODE_CRITIC_PREAMBLE + '## Implementation Output\n\n' + outputStr,
        output,
      });

      // Test critic: gets job scope + spec + test files, reviews whether tests are sufficient
      const testCriticJob = jobManager.startJob('eval', {
        source_job_id: job_id,
        eval_stage: 'test_critic',
        prompt: jobScope + TEST_CRITIC_PREAMBLE + '## Test Files and Spec\n\n' + outputStr,
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
