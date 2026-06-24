import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { loadCriticRoster, type ResolvedCritic } from '../../core/critic-roster.js';
import { StateStore } from '../../core/state-store.js';
import type { Job, JobType } from '../../types/index.js';
import { jsonResult, type RegisterTool } from './utils.js';

const buildJobScopeSection = (stateStore: StateStore, jobId: string): string => {
  const job = stateStore.getJob(jobId);
  if (!job) {
    return '';
  }

  const name = typeof job.params.name === 'string' ? job.params.name : 'unknown';
  const dagId = typeof job.params.dag_id === 'string' ? job.params.dag_id : '';
  const prompt = typeof job.params.prompt === 'string' ? job.params.prompt : '';
  const runSlug = typeof job.params.run_slug === 'string' ? job.params.run_slug : undefined;
  const runPath = typeof job.params.run_path === 'string' ? job.params.run_path : undefined;
  const artifactPaths = job.params.artifact_paths && typeof job.params.artifact_paths === 'object'
    ? JSON.stringify(job.params.artifact_paths)
    : undefined;
  const doctrineAuthorized = job.params.allow_project_doctrine_edits === true;

  return [
    '## Job Scope (evaluate ONLY against this scope)',
    '',
    `**Job**: ${dagId ? `${dagId} — ` : ''}${name}`,
    `**Deliverables**: ${prompt}`,
    ...(runSlug ? [`**Run slug**: ${runSlug}`] : []),
    ...(runPath ? [`**Run path**: ${runPath}`] : []),
    ...(artifactPaths ? [`**Artifact paths**: ${artifactPaths}`] : []),
    `**Project doctrine edits authorized**: ${doctrineAuthorized ? 'yes' : 'no'}`,
    '',
    'CRITICAL: Only evaluate work that falls within THIS job\'s scope above.',
    'Features, tests, or capabilities assigned to OTHER jobs in the DAG are OUT OF SCOPE.',
    'If project doctrine edits are not authorized, any change under `.tenet/project/**` is OUT OF SCOPE and must be reported as `scope_conflict`.',
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
  '  Also use "scope_conflict" when project doctrine edits are not authorized and the job changed `.tenet/project/**`.',
  '',
  'End with: {"passed": true/false, "stage": "code_critic", "findings": [{"category": "product_bug", "detail": "..."}, ...]}',
  '',
].join('\n');

const PLAYWRIGHT_EVAL_PREAMBLE = [
  '## Interaction E2E — Live Application Verification',
  '',
  'You are the INTERACTION E2E worker. You do NOT review code.',
  'You verify the project ACTUALLY WORKS through the public user-facing surface declared in the spec/harness.',
  '',
  '### First: classify the project surface',
  'Read the source job scope above. Use exact artifact_paths when provided, the run-local spec/harness/scenarios, and `.tenet/project/testing.md` / `.tenet/project/design.md` as the authoritative context.',
  'Determine whether this job needs web/browser UI, game/canvas/visual, CLI, API, library, or no e2e surface.',
  'Do NOT force Playwright for CLI/API/library work unless the harness explicitly requires browser verification.',
  '',
  'If the harness/spec declares e2e or visual exploration as skipped, optional, mocked, or not applicable, honor that policy and state the reason.',
  '',
  '### Browser/UI path — Two-Layer Testing',
  '',
  'If the feature is browser UI, game/canvas, visual, or otherwise requires browser interaction, do BOTH layers unless the harness explicitly says Layer 2 is optional or skipped:',
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
  '### CLI/API/library path',
  '',
  'If this is not a browser UI feature:',
  '- CLI: run the public CLI commands from scenarios and verify exit code, stdout/stderr, files, and side effects',
  '- API: run the project acceptance/integration tests or direct HTTP workflow checks declared in the harness',
  '- Library: run integration tests through the public API; do not invent browser checks',
  '- Set layer2_status to "not_applicable" when browser exploration is not part of the declared e2e surface',
  '',
  '### What to Report',
  '- Surface classification and harness policy used',
  '- Layer 1 results: scripted test pass/fail counts',
  '- Layer 2 findings: bugs found via exploration that scripted tests missed',
  '- Visual issues observed in screenshots (broken layouts, missing elements)',
  '- Features in spec that have NO accessible UI path',
  '',
  '### If Playwright MCP is not available',
  'If browser/visual Layer 2 is REQUIRED by the harness/spec: FAIL the eval.',
  'If browser/visual Layer 2 is optional or skipped with reason: report "Playwright MCP not installed — exploratory testing skipped" and pass with Layer 1 results only.',
  'If browser/visual Layer 2 is not applicable to this project surface: do the non-browser e2e path and report not_applicable.',
  '',
  '### If the application won\'t start',
  'FAIL the eval. The application must start to be tested.',
  '',
  '### Required output fields',
  'You MUST set layer2_status to one of:',
  '- "completed" — you exercised the app interactively via Playwright MCP and the findings below reflect that exploration',
  '- "skipped_no_mcp" — Playwright MCP was not available and the harness/spec allowed skipping browser exploration',
  '- "not_applicable" — browser exploration is not part of this feature\'s declared e2e surface',
  '- "failed" — Layer 2 was attempted but failed to run (app would not start, MCP tool errors, etc.)',
  '',
  'The final status summary will show layer2_status directly — do not treat "passed" as equivalent to "fully verified". If Layer 2 was skipped, that must be visible downstream.',
  '',
  'End with: {"passed": true/false, "stage": "playwright_eval", "surface": "web_ui|visual|cli|api|library|none", "layer2_status": "completed|skipped_no_mcp|not_applicable|failed", "scripted_results": "...", "exploratory_findings": ["..."], "screenshots": ["..."]}',
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

type CriticDispatch = {
  jobType: JobType;
  evalStage: string;
  prompt: string;
};

/**
 * Resolve one roster critic into a dispatchable job spec (job type + eval stage
 * + full prompt). Returns null when the critic should be skipped:
 * - unknown built-in id (shouldn't happen — resolver guards it), or
 * - a custom critic whose `prompt_file` is missing/unreadable.
 *
 * The job scope (eval-only-within-this-scope preamble) is prepended to every
 * critic; built-ins append their fixed preamble, customs append their prompt
 * file. Built-ins don't receive the implementation output verbatim except where
 * their preamble expects it; customs always get the output so the prompt file
 * can instruct the critic to use it.
 */
const buildCriticDispatch = (
  critic: ResolvedCritic,
  jobScope: string,
  outputStr: string,
  projectPath: string,
): CriticDispatch | null => {
  if (critic.builtin) {
    switch (critic.id) {
      case 'code_critic':
        return {
          jobType: critic.jobType,
          evalStage: critic.stage,
          prompt: jobScope + CODE_CRITIC_PREAMBLE + '## Implementation Output\n\n' + outputStr,
        };
      case 'test_critic':
        return {
          jobType: critic.jobType,
          evalStage: critic.stage,
          prompt: jobScope + TEST_CRITIC_PREAMBLE + '## Test Files and Spec\n\n' + outputStr,
        };
      case 'playwright_eval':
        return {
          jobType: critic.jobType,
          evalStage: critic.stage,
          prompt: jobScope + PLAYWRIGHT_EVAL_PREAMBLE,
        };
      default:
        return null;
    }
  }

  // Custom critic: read its prompt file (project-relative or absolute).
  if (!critic.promptFile) {
    return null;
  }
  const absPromptPath = path.isAbsolute(critic.promptFile)
    ? critic.promptFile
    : path.join(projectPath, critic.promptFile);
  let promptBody: string;
  try {
    promptBody = fs.readFileSync(absPromptPath, 'utf8');
  } catch {
    return null;
  }
  return {
    jobType: critic.jobType,
    evalStage: critic.stage,
    prompt: jobScope + promptBody + '\n## Implementation Output\n\n' + outputStr,
  };
};

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
        'Start evaluation pipeline for a completed job. Dispatches the configured critics from ' +
        '.tenet/critics.json (3 built-in by default: code critic, test critic, interaction-e2e; plus any ' +
        'user-defined custom critics). Each critic runs in an independent context with no author reasoning ' +
        'and evaluates ONLY against the specific job\'s scope, not the full spec. ' +
        'Code critic — purpose alignment check (spec + diff). Test critic — test sufficiency (spec + tests). ' +
        'Interaction-e2e — public-surface e2e checks declared by the harness; uses scripted Playwright plus ' +
        'Playwright MCP only when browser/visual verification applies. Custom critics use their own prompt ' +
        'under .tenet/critics/. Execution mode (parallel vs sequential) is decided by the readiness verdict ' +
        'stored at eval_parallel_safe:{feature}; when missing or false, critics run sequentially in roster ' +
        'order to avoid contention on shared state (DB, sessions, rate limits, ports). ' +
        'Returns a jobs[] list of every dispatched critic (variable length). Wait for all to complete. ALL must pass.',
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
      const projectPath = stateStore.projectPath;

      const resolvedFeature = feature ?? (() => {
        const source = stateStore.getJob(job_id);
        return source && typeof source.params.feature === 'string' ? source.params.feature : undefined;
      })();

      const parallelSafe = resolveEvalParallelSafe(stateStore, resolvedFeature);

      // Resolve the roster and build the dispatch list. A critic whose prompt
      // can't be built (e.g. a custom critic with a missing prompt file) is
      // skipped and reported, never fatal.
      const { critics: roster, warning: rosterWarning } = loadCriticRoster(projectPath);
      const enabledCritics = roster.filter((c) => c.enabled);
      const dispatchList: CriticDispatch[] = [];
      const skippedCritics: string[] = [];
      for (const critic of enabledCritics) {
        const dispatch = buildCriticDispatch(critic, jobScope, outputStr, projectPath);
        if (!dispatch) {
          skippedCritics.push(critic.id);
          continue;
        }
        dispatchList.push(dispatch);
      }

      // Stages the resume gate waits for = exactly the stages we dispatched.
      const expectedEvalStages = dispatchList.map((d) => d.evalStage);

      const buildParams = (d: CriticDispatch) => ({
        source_job_id: job_id,
        eval_stage: d.evalStage,
        name: `${d.evalStage} for ${job_id.slice(0, 8)}`,
        prompt: d.prompt,
        output,
        expected_eval_stages: expectedEvalStages,
        ...(resolvedFeature ? { feature: resolvedFeature } : {}),
      });

      type Dispatched = { role: string; id: string; status: Job['status']; parentJobId?: string };
      const dispatched: Dispatched[] = [];

      if (dispatchList.length === 0) {
        return jsonResult({
          jobs: [],
          eval_parallel_safe: parallelSafe,
          execution_mode: parallelSafe ? 'parallel' : 'sequential',
          critics_dispatched: 0,
          ...(rosterWarning ? { roster_warning: rosterWarning } : {}),
          ...(skippedCritics.length ? { skipped_critics: skippedCritics } : {}),
          message:
            'No critics dispatched — the roster has no enabled critics with readable prompts. Eval cannot pass without at least one critic.',
        });
      }

      if (parallelSafe) {
        for (const d of dispatchList) {
          const job = jobManager.startJob(d.jobType, buildParams(d));
          dispatched.push({ role: d.evalStage, id: job.id, status: job.status });
        }
      } else {
        // Sequential: start the first critic; register the rest as pending with
        // auto_dispatch_on_parent_complete so job-manager chains them in roster order.
        let prevId: string | undefined;
        for (const d of dispatchList) {
          if (prevId === undefined) {
            const job = jobManager.startJob(d.jobType, buildParams(d));
            dispatched.push({ role: d.evalStage, id: job.id, status: job.status });
            prevId = job.id;
          } else {
            const job = jobManager.createPendingJob(
              d.jobType,
              { ...buildParams(d), auto_dispatch_on_parent_complete: true },
              prevId,
            );
            dispatched.push({ role: d.evalStage, id: job.id, status: job.status, parentJobId: job.parentJobId });
            prevId = job.id;
          }
        }
      }

      return jsonResult({
        jobs: dispatched.map(({ role, id, status, parentJobId }, idx) => ({
          role,
          job_id: id,
          status,
          lifecycle: parallelSafe
            ? status === 'running'
              ? 'running'
              : status
            : idx === 0
              ? status === 'running'
                ? 'running'
                : status
              : 'queued_after_parent',
          ...(parentJobId ? { parent_job_id: parentJobId } : {}),
          next_tool: 'tenet_job_wait',
          next_args: { job_id: id, wait_seconds: 30 },
        })),
        eval_parallel_safe: parallelSafe,
        execution_mode: parallelSafe ? 'parallel' : 'sequential',
        critics_dispatched: dispatched.length,
        ...(rosterWarning ? { roster_warning: rosterWarning } : {}),
        ...(skippedCritics.length ? { skipped_critics: skippedCritics } : {}),
        message: parallelSafe
          ? `${dispatched.length} critic(s) dispatched in parallel. Wait for all via tenet_job_wait + tenet_job_result. ALL must pass.`
          : `Critics dispatched sequentially in roster order. Wait for each via tenet_job_wait + tenet_job_result. ALL must pass.`,
      });
    },
  );
};
