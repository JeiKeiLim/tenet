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
  '## Interaction E2E — Agent-Driven Verification Through the Public Surface',
  '',
  'You are the INTERACTION E2E worker. You do NOT review code.',
  'You verify the project ACTUALLY WORKS by exercising its public user-facing surface the way a real user would — with exploratory, agent-driven probing, not just the scripted checks the author wrote.',
  '',
  'The job type stays `playwright_eval` for compatibility, but "Playwright" is only the browser tool. The surface may be a browser UI, a TUI, a CLI, an API, a library, or nothing. You classify first and apply the SAME exploratory rigor to whichever it is — never skip a non-browser surface, and never force a browser onto one.',
  '',
  '### First: classify the surface',
  'Read the source job scope above. Use exact artifact_paths when provided, the run-local spec/harness/scenarios, and `.tenet/project/testing.md` / `.tenet/project/design.md` as the authoritative context.',
  'Classify the declared e2e surface: `web_ui` (browser), `visual` (canvas/game/rendered), `cli`, `api`, `library`, or `none`.',
  'Honor the harness/spec policy: if it declares e2e or a surface as skipped, optional, mocked, or not applicable, follow it and state the reason. Do not invent a surface the harness says is absent, and do not force Playwright for CLI/API/library work unless browser verification is explicitly required.',
  '',
  '### Apply agent-brain QA to your surface (ALL surfaces)',
  '',
  'Whatever surface you classified, do not stop at the happy path the author declared. Probe it like a real, hostile user:',
  '- Edge and invalid inputs — empty, huge, unicode, wrong type, missing required values, off-by-one boundaries.',
  '- Error paths — confirm failures produce the right non-zero exit / error status / clear message, not a silent success or a crash.',
  '- Undocumented surface area — flags/endpoints/arguments the scenarios omit but a real user would try (`--help`, `--version`, unknown subcommands, default no-arg behavior).',
  '- Chained workflows — run commands/calls in sequence the way a user actually operates, not only in isolation.',
  '- Regression traps — anything a scripted/declared check would pass but a human would notice is wrong.',
  '',
  'Then follow the branch for your surface.',
  '',
  '### Browser surface (web_ui / visual / canvas)',
  '',
  'Do BOTH layers unless the harness/spec explicitly marks Layer 2 optional or skipped with reason.',
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
  '5. Apply the agent-brain QA list above in the browser: click every button on every page, try invalid inputs and verify error messages, test navigation between pages, confirm every spec feature is reachable from the UI.',
  '',
  '### CLI surface',
  '',
  'Run the public commands declared in scenarios and verify exit code, stdout/stderr, files, and side effects — then go beyond them:',
  '- Probe `--help`, `--version`, unknown flags/subcommands, and default (no-arg) behavior.',
  '- Feed invalid/empty/huge/unicode/wrong-type arguments and confirm the exit code is non-zero and stderr is accurate and helpful (not a stack trace or silent success).',
  '- Chain commands across one session the way a real user operates (init → configure → run → inspect output).',
  '- Exercise pipes, stdin, interactive prompts, and signals where the CLI exposes them.',
  '- Check disk/env/config side effects, not just stdout.',
  '',
  '### API surface',
  '',
  'Run the acceptance/integration tests or HTTP workflow checks declared in the harness — then probe beyond them:',
  '- Hit endpoints and parameters NOT in the scenarios; try wrong HTTP method, unauthenticated, malformed/empty body, and boundary inputs.',
  '- Verify response body and status SEMANTICS, not just non-5xx (e.g. a create that 200s without persisting, or a 404 that should be a 401).',
  '- Check auth/authorization boundaries and error envelopes for consistency.',
  '',
  '### Library surface',
  '',
  'Exercise the public API exploratorially, not just the happy-path integration tests:',
  '- Boundary and invalid inputs to public functions/methods.',
  '- Contract-vs-docs drift — does the public signature actually behave as documented?',
  '- Error paths — documented exceptions/returns vs what actually happens.',
  '- Do not invent a CLI/browser surface if the package exposes only a programmatic API.',
  '',
  '### No e2e surface',
  '',
  'If the harness/spec declares no public surface for this job (pure internal module), set `surface: "none"` and `layer2_status: "not_applicable"`, state the reason, and pass — unless the harness REQUIRED a surface that is missing, in which case FAIL.',
  '',
  '### What to Report',
  '- Surface classification and the harness/spec policy you followed',
  '- Scripted results (Layer 1 / declared-scenario / declared-test pass-fail counts)',
  '- Exploratory findings: bugs your agent-brain probing found that the scripted/declared checks missed, for ANY surface',
  '- Visual issues observed in screenshots (browser surface)',
  '- Declared features with NO reachable path through the surface',
  '',
  '### If Playwright MCP is not available (browser surface only)',
  'This only matters when your classified surface needs the browser. If browser/visual Layer 2 is REQUIRED by the harness/spec: FAIL the eval. If it is optional or skipped with reason: report "Playwright MCP not installed — exploratory browser testing skipped" and pass on Layer 1 results only. For CLI/API/library/none surfaces Playwright MCP is irrelevant — proceed with that branch.',
  '',
  '### If a required runtime won\'t start',
  'Only surfaces that need a running app/server apply here (browser, API). If the application won\'t start, FAIL the eval — it must run to be tested. CLI/library surfaces that need no server are unaffected.',
  '',
  '### Required output fields',
  'You MUST set layer2_status to one of:',
  '- "completed" — you exercised a BROWSER surface interactively via Playwright MCP and the findings below reflect that exploration',
  '- "skipped_no_mcp" — browser Layer 2 was required-but-unavailable and the harness/spec allowed skipping it',
  '- "not_applicable" — this surface is not a browser (cli/api/library/none); the non-browser e2e still ran and its result is in exploratory_findings',
  '- "failed" — Layer 2 (browser) or a required runtime was attempted but could not run',
  '',
  'The final status summary will show layer2_status directly — do not treat "passed" as equivalent to "fully verified". For non-browser surfaces "not_applicable" is honest and expected, not a gap; report the real e2e result in exploratory_findings.',
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
        'Interaction-e2e — agent-driven verification through the job\'s public surface (browser UI via ' +
        'Playwright MCP; CLI/API/library via shell), exploratory not just scripted. Custom critics use their own prompt ' +
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
