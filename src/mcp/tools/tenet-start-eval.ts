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
  'SEVERITY RULE: There is no "minor" or "non-blocking" category. ALL findings are blocking.',
  'If you find an issue — no matter how small (missing CASCADE, unused import, inconsistent',
  'naming) — the job FAILS. There is no human to catch deferred issues. Fix everything now.',
  'A "pass with minor findings" is a FAIL.',
  '',
  '### Finding categories (required)',
  'Each finding MUST include a "category" so the orchestrator can route follow-up work correctly:',
  '- "product_bug": implementation does not match spec intent',
  '- "test_bug": test asserts the wrong thing, would pass when it should fail',
  '- "harness_bug": build/lint/test infra itself is broken',
  '- "evidence_mismatch": report claims numbers that fresh commands contradict',
  '- "contention": failure looks like sibling eval stepping on shared state',
  '- "scope_conflict": work violates declared job scope (e.g. report-only job edited files)',
  '',
  'End with: {"passed": true/false, "stage": "code_critic", "findings": [{"category": "product_bug", "detail": "..."}, ...]}',
  '',
].join('\n');

const PLAYWRIGHT_EVAL_PREAMBLE = [
  '## Playwright E2E — Live Application Verification',
  '',
  'You are the PLAYWRIGHT EVAL worker. You do NOT review code or test files.',
  'You verify the application ACTUALLY WORKS by interacting with it like a real user.',
  '',
  '### Two-Layer Testing (you MUST do BOTH)',
  '',
  '#### Layer 1: Scripted Playwright Tests (regression)',
  '1. Locate existing Playwright test files (tests/e2e/, e2e/, tests/playwright/, or similar)',
  '2. Ensure the application is running (start dev server or docker compose if needed)',
  '3. Run: `npx playwright test` (or the project\'s test command)',
  '4. Report all passing and failing tests',
  '',
  '#### Layer 2: Exploratory Agent-Driven Testing (Playwright MCP)',
  'Use the Playwright MCP tools (playwright_navigate, playwright_click, playwright_fill,',
  'playwright_screenshot, playwright_get_visible_text) to test EVERY scenario from the spec.',
  '',
  'For each scenario in scope:',
  '1. Navigate to the entry point',
  '2. Perform the user actions (click, fill, submit)',
  '3. Take a screenshot at each step',
  '4. Verify the EXPECTED OUTCOME (not just absence of errors):',
  '   - After login: did the URL change to /dashboard? Is user info visible?',
  '   - After create: does the new item appear in the list?',
  '   - After form submit: did it redirect to the correct page?',
  '5. Test edge cases the scripted tests miss:',
  '   - Click every button on every page',
  '   - Try invalid inputs and verify error messages',
  '   - Test navigation between pages',
  '   - Verify all features mentioned in spec are reachable from the UI',
  '',
  '### What to Report',
  '- Layer 1 results: scripted test pass/fail counts',
  '- Layer 2 findings: bugs found via exploration that scripted tests missed',
  '- Visual issues observed in screenshots (broken layouts, missing elements)',
  '- Features in spec that have NO accessible UI path',
  '',
  '### If Playwright MCP is not available',
  'Report "Playwright MCP not installed — exploratory testing skipped" and pass with',
  'Layer 1 results only. Do NOT fail the eval just because Playwright MCP is missing.',
  '',
  '### If the application won\'t start',
  'FAIL the eval. The application must start to be tested.',
  '',
  '### Required output fields',
  'You MUST set layer2_status to one of:',
  '- "completed" — you exercised the app interactively via Playwright MCP and the findings below reflect that exploration',
  '- "skipped_no_mcp" — Playwright MCP was not available; only Layer 1 (scripted) results are reported',
  '- "failed" — Layer 2 was attempted but failed to run (app would not start, MCP tool errors, etc.)',
  '',
  'The final status summary will show layer2_status directly — do not treat "passed" as equivalent to "fully verified". If Layer 2 was skipped, that must be visible downstream.',
  '',
  'End with: {"passed": true/false, "stage": "playwright_eval", "layer2_status": "completed|skipped_no_mcp|failed", "scripted_results": "...", "exploratory_findings": ["..."], "screenshots": ["..."]}',
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
  '### THE ORACLE PROBLEM (critical awareness)',
  'The same AI agent wrote both the code AND the tests. Research shows this creates',
  '"oracle leakage" — tests that verify what was IMPLEMENTED rather than what was INTENDED.',
  'Test precision drops to ~6% when the same context writes both. You MUST check for this.',
  '',
  '### Test Quality Checklist',
  'For each scenario IN THIS JOB\'S SCOPE, check:',
  '- Is there a test that covers this scenario?',
  '- Does the test verify the CORRECT OUTCOME, not just absence of errors?',
  '  - BAD: "expect no error" / "expect page loads" / "expect status 200"',
  '  - GOOD: "expect redirect to /dashboard" / "expect created item appears in list"',
  '- After login: does the test verify session persistence (reload still authenticated)?',
  '- After create: does the test verify the item is visible in a list/detail view?',
  '- After form submit: does the test verify redirect to the CORRECT destination?',
  '',
  '### Oracle Leak Detection',
  '- Do tests mirror the implementation structure (testing private methods, internal state)?',
  '  If so, they test HOW it works, not WHAT it does. FAIL.',
  '- Do tests use hardcoded values that match implementation constants? SUSPICIOUS.',
  '- Do tests only verify happy paths without any error/edge case testing? FAIL.',
  '- Would these tests catch a bug if someone changed the implementation? If unsure, FAIL.',
  '',
  '### Behavioral Test Requirements',
  '- Tests MUST verify observable behavior from a user/consumer perspective',
  '- For APIs: test request → response content, not internal function calls',
  '- For UI: test user action → visible result, not component state',
  '- For libraries: test public API → return values, not private methods',
  '',
  '### Coverage Requirements',
  '- Every feature in this job\'s scope MUST have at least one behavioral test',
  '- Every API endpoint MUST have a test verifying correct response body (not just status code)',
  '- Every form/interactive element MUST have a test verifying the complete flow',
  '- If a feature has no tests at all, this is an automatic FAIL',
  '',
  'If tests are insufficient, list SPECIFIC tests that need to be added or strengthened.',
  'Be STRICT. "Some tests exist" is not sufficient. Tests must actually catch bugs.',
  '',
  '### Finding categories (required)',
  'Each finding MUST include a "category" (same schema as the code critic):',
  '- "product_bug", "test_bug", "harness_bug", "evidence_mismatch", "contention", "scope_conflict"',
  '',
  'End with: {"passed": true/false, "stage": "test_critic", "findings": [{"category": "test_bug", "detail": "..."}, ...], "missing_tests": ["..."]}',
  '',
].join('\n');

const resolveEvalParallelSafe = (stateStore: StateStore, feature?: string): boolean => {
  if (!feature) {
    // No feature → default to sequential (safe fallback)
    return false;
  }
  const raw = stateStore.getConfig(`eval_parallel_safe:${feature}`);
  if (raw === 'true') {
    return true;
  }
  // 'false', missing, or any other value → sequential
  return false;
};

export const registerTenetStartEvalTool = (registerTool: RegisterTool, jobManager: JobManager, stateStore: StateStore): void => {
  registerTool(
    'tenet_start_eval',
    {
      description:
        'Start evaluation pipeline for a completed job. Dispatches THREE eval jobs: ' +
        '(1) Code critic — independent purpose alignment check (spec + diff only, no author reasoning), ' +
        '(2) Test critic — reviews whether tests are sufficient to prove features work (spec + tests only), ' +
        '(3) Playwright eval — runs scripted Playwright tests AND exploratory agent-driven testing via Playwright MCP. ' +
        'All three evaluate ONLY against the specific job\'s scope, not the full spec. ' +
        'Execution mode (parallel vs sequential) is decided by the readiness verdict stored at ' +
        'eval_parallel_safe:{feature}. When the verdict is missing or false, critics run sequentially ' +
        'to avoid contention on shared state (DB, sessions, rate limits, ports). ' +
        'Returns all three job IDs. Wait for all three to complete. ALL must pass.',
      inputSchema: z.object({
        job_id: z.string().uuid(),
        output: z.record(z.string(), z.unknown()),
        feature: z
          .string()
          .optional()
          .describe(
            'Feature slug used to look up eval_parallel_safe:{feature} in config. If omitted, critics run sequentially (safe fallback).',
          ),
      }),
    },
    async ({ job_id, output, feature }) => {
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      const jobScope = buildJobScopeSection(stateStore, job_id);

      const resolvedFeature = feature ?? (() => {
        const source = stateStore.getJob(job_id);
        return source && typeof source.params.feature === 'string' ? source.params.feature : undefined;
      })();

      const parallelSafe = resolveEvalParallelSafe(stateStore, resolvedFeature);

      const codeCriticParams = {
        source_job_id: job_id,
        eval_stage: 'code_critic',
        name: `code_critic for ${job_id.slice(0, 8)}`,
        prompt: jobScope + CODE_CRITIC_PREAMBLE + '## Implementation Output\n\n' + outputStr,
        output,
        ...(resolvedFeature ? { feature: resolvedFeature } : {}),
      };

      const testCriticParams = {
        source_job_id: job_id,
        eval_stage: 'test_critic',
        name: `test_critic for ${job_id.slice(0, 8)}`,
        prompt: jobScope + TEST_CRITIC_PREAMBLE + '## Test Files and Spec\n\n' + outputStr,
        output,
        ...(resolvedFeature ? { feature: resolvedFeature } : {}),
      };

      const playwrightParams = {
        source_job_id: job_id,
        eval_stage: 'playwright_eval',
        name: `playwright_eval for ${job_id.slice(0, 8)}`,
        prompt: jobScope + PLAYWRIGHT_EVAL_PREAMBLE,
        output,
        ...(resolvedFeature ? { feature: resolvedFeature } : {}),
      };

      let codeCriticJob;
      let testCriticJob;
      let playwrightEvalJob;

      if (parallelSafe) {
        codeCriticJob = jobManager.startJob('critic_eval', codeCriticParams);
        testCriticJob = jobManager.startJob('eval', testCriticParams);
        playwrightEvalJob = jobManager.startJob('playwright_eval', playwrightParams);
      } else {
        // Sequential: dispatch code critic; register test critic + playwright as pending
        // with auto_dispatch_on_parent_complete so job-manager chains them on success.
        codeCriticJob = jobManager.startJob('critic_eval', codeCriticParams);
        testCriticJob = jobManager.createPendingJob(
          'eval',
          { ...testCriticParams, auto_dispatch_on_parent_complete: true },
          codeCriticJob.id,
        );
        playwrightEvalJob = jobManager.createPendingJob(
          'playwright_eval',
          { ...playwrightParams, auto_dispatch_on_parent_complete: true },
          testCriticJob.id,
        );
      }

      return jsonResult({
        code_critic_job_id: codeCriticJob.id,
        test_critic_job_id: testCriticJob.id,
        playwright_eval_job_id: playwrightEvalJob.id,
        eval_parallel_safe: parallelSafe,
        execution_mode: parallelSafe ? 'parallel' : 'sequential',
        message: parallelSafe
          ? 'Code critic, test critic, and Playwright eval dispatched in parallel. Wait for all three using tenet_job_wait + tenet_job_result. ALL must pass.'
          : 'Critics dispatched sequentially (code → test → playwright) based on readiness verdict. Wait for each via tenet_job_wait + tenet_job_result. ALL must pass.',
      });
    },
  );
};
