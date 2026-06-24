# Phase 6: Evaluation

The evaluation pipeline ensures that all implemented work meets both mechanical requirements and the original intent. It enforces a strict separation between the author and the critic to prevent leniency.

## Finding Categories

Every critic finding (code critic, test critic) MUST include a `category` so the orchestrator can route fix work correctly instead of blindly retrying the source job:

| Category | Meaning | Orchestrator action |
|----------|---------|---------------------|
| `product_bug` | Implementation does not match spec intent | Retry the source dev job |
| `test_bug` | Tests assert wrong thing or would pass when they should fail | Retry with explicit test-strengthening requirements |
| `harness_bug` | Build/lint/test harness itself is broken | Retry or remediate with scope limited to build/CI/scripts |
| `evidence_mismatch` | Report numbers don't match fresh command output | Re-run the source job's verification commands, refresh report |
| `contention` | Failure looks like sibling eval stepping on shared state | Re-run after siblings complete, or switch to sequential mode |
| `scope_conflict` | Job edited files outside its declared scope (e.g. report-only job touched code, or a normal job edited `.tenet/project/**`) | Trigger the blocking finding escape hatch (see 05-execution-loop.md) |

The critic emits findings as objects: `{"category": "...", "detail": "..."}`. Orchestrators MUST read the category to pick the right response — plain retry loops waste cycles on bugs that aren't product bugs.

## E2E Surface And Playwright Layer 2 Honesty

The e2e eval job returns a `surface` field and a `layer2_status` field so downstream readers can distinguish browser-verified work from scripted-only or non-browser verification:

- `completed` — Layer 2 exploratory testing ran via Playwright MCP. Findings reflect real interactive use.
- `skipped_no_mcp` — Playwright MCP was not installed and the harness/spec allowed browser exploration to be skipped. Only scripted (Layer 1) results are reported.
- `not_applicable` — browser exploration is not part of this feature's declared e2e surface (for example CLI, API, library, or no e2e surface).
- `failed` — Layer 2 was attempted but could not complete (app wouldn't start, MCP errors).

`tenet_get_status` surfaces the latest completed playwright_eval's `layer2_status` as `latest_playwright_layer2_status` so final reports can state honestly whether visual verification happened. A "passed" verdict with `layer2_status: skipped_no_mcp` is NOT the same as fully verified — say so in the final report.

If the harness/spec says browser or visual exploration is required, missing Playwright MCP is a failure. If the harness/spec says it is optional or skipped with reason, `skipped_no_mcp` is acceptable. For CLI/API/library projects, do the declared public-surface e2e checks instead of forcing Playwright.

## Parallel vs Sequential Critics

The configured critic jobs may run **in parallel** or **sequentially**, decided by the readiness gate verdict (`eval_parallel_safe:{feature}` in the config table). The critic set comes from `.tenet/critics.json` — 3 built-in by default (code critic, test critic, interaction-e2e), plus any project-defined custom critics (see `../critics.md`):

- **Parallel** (verdict `true`) — pure libraries, CLIs, data pipelines with no shared mutable state. Critics start concurrently; completion time ≈ slowest single critic.
- **Sequential** (verdict `false` or missing) — stateful web apps where critics would collide on shared state (DB rows, sessions, rate-limit counters, ports, Playwright lock dirs). Critics run in roster order (code → test → playwright by default). The caller receives every critic's job id up front in `jobs[]`; job-manager auto-dispatches each downstream critic when its predecessor completes.

`tenet_start_eval` reads the verdict automatically — no orchestrator code change needed. If the verdict is missing, Tenet defaults to sequential (safe fallback). Disabling a built-in or adding a custom critic in `.tenet/critics.json` changes which (and how many) critics run; the blocking-finding resume gate tracks the same configured set, so disabling a critic does not strand a blocked parent.

## The 5 Evaluation Stages

### Stage 1: Mechanical
Automated checks with no human judgment. Run these commands and verify exit codes:
- **Lint**: Run the project linter from harness config.
- **Build**: Execute the build command.
- **Type-check**: Verify types across the changed files.
- **Tests**: Run the full test suite (unit + acceptance tests if they exist).
**PASS**: All exit 0. **FAIL**: Any non-zero exit code.

### Stage 1.5: Smoke Check (MANDATORY for dev jobs)
After mechanical checks pass, verify the implementation actually works at runtime:

**For server/API features:**
1. Start the application server
2. Hit each relevant API endpoint with a basic request
3. Verify non-5xx responses (200, 201, 301, 404 are OK — 500 is a fail)
4. Stop the server

**For frontend features:**
1. Start the dev server
2. Navigate to each relevant page
3. Verify pages render without console errors or blank screens
4. If Playwright is available, run `npx playwright test` against acceptance tests

**For CLI/library features:**
1. Run the CLI with basic arguments
2. Verify exit code and output format

**PASS**: Server starts, endpoints respond, pages render. **FAIL**: Server won't start, endpoints return 500, pages are blank/error.

A smoke check failure is a Stage 1 failure — the job cannot pass eval.

### Stage 2: Property-based
If the harness or spec defines property tests, run them now. These properties must predate the implementation. Skip if no property tests exist.

### Stage 3: Code Critic (Independent Context)
A separate agent session with no prior implementation history performs this review. It receives the spec, scenarios, harness, and the diff, but never the author's reasoning or prior conversation.

The code critic checks:
- Does the implementation match the spec's intent?
- Are any anti-scenarios violated?
- Are there obvious gaps or missing edge cases?
- Did the job edit `.tenet/project/**` without authorization? Authorization = the job was dispatched with `allow_project_doctrine_edits: true` (context-bootstrap, or a doctrine-maintenance job — see `phases/05-execution-loop.md` → *Applying a proposal*), or a direct user request. If edits are unauthorized, fail with `category: "scope_conflict"`.

**Zero-findings rule**: If the critic finds nothing, it must re-analyze using an alternate attack vector like security, performance, or concurrency. Zero findings trigger a mandatory second pass.

Then performs structured self-questioning:
- **Edge cases**: Empty input? Max values? Unicode?
- **Error paths**: Dependency failures? Timeouts? Disk full?
- **Integration**: Does this break upstream or downstream components?
- **Security**: Input validation? Secret exposure? Injection?
- **Performance**: N+1 queries? Unbounded loops? Memory leaks?

### Stage 4: Test Critic (Independent Context)
A separate agent session reviews whether the tests are **sufficient to prove the features actually work**. It receives the spec, scenarios, and acceptance/integration test files — NOT the implementation code.

The test critic checks:
- For each scenario: is there a test that covers it?
- Does each test verify the **correct outcome**, not just absence of errors?
  - BAD: `expect(page).not.toHaveURL(/error/)` — passes even if login redirects back to login
  - GOOD: `expect(page).toHaveURL(/dashboard/)` — fails if login doesn't actually work
- After login: does the test verify session persists across reload?
- After create: does the test verify the item appears in a list/view?
- After form submit: does the test verify redirect to the correct destination?
- Are there routes/pages/endpoints with NO test coverage at all?
- Are there interactive elements (buttons, forms) with no test?

If tests are insufficient, the test critic outputs specific tests that need to be added or strengthened. These become requirements for a retry or blocking-finding follow-up before the integration checkpoint can pass.

## Integration Test Evaluation

Integration test jobs (`integration_test` type) have a different eval flow:
1. The integration test agent runs acceptance tests and reports results
2. If ALL tests pass → job completes successfully
3. If ANY test fails → job fails with detailed failure report
4. On failure, report-only integration jobs report a blocking finding with `tenet_report_blocking_finding`
5. After linked follow-up children complete and pass eval, the integration test is retried

The orchestrator should parse the integration test output to identify specific failures and report a focused blocking finding rather than retrying the entire feature.

## Evaluation Result Format
Record results via `tenet_update_knowledge` with a descriptive title. Example: `title="eval project-scaffold mechanical-and-spec-compliance"`. The tool defaults to `type="journal"` and writes a dated markdown file in the run journal (`.tenet/runs/<run-slug>/journal/`); pass `type="knowledge"` only for durable facts worth promoting to `.tenet/knowledge/`.

```markdown
# Evaluation: job-{id}

## Stage 1: Mechanical
- lint: PASS/FAIL
- build: PASS/FAIL
- typecheck: PASS/FAIL
- tests: PASS/FAIL (N/M passed)

## Stage 1.5: Smoke Check
- server start: PASS/FAIL
- endpoint /api/xxx: PASS/FAIL (status code)
- page /xxx: PASS/FAIL (renders/error)

## Stage 3: Code Critic
- Finding 1: Description
- Zero-findings recheck: [done/not-needed]
- Self-questioning results: [edge cases/security/performance]

## Stage 4: Test Critic
- Scenario coverage: [N/M scenarios have tests]
- Outcome verification: PASS/FAIL (tests verify outcomes, not just absence of errors)
- Missing tests: [list of tests that need to be added]
- Insufficient assertions: [list of tests that need stronger assertions]

## Overall: PASS / FAIL
```

## Handling Failures
- **Stage 1/1.5 Fail**: Retry the current implementation job with an enhanced prompt that includes the mechanical/runtime failure.
- **Stage 3 Fail (Code Critic)**: Run reflection to find the root cause, then retry via `tenet_retry_job` with the critic findings.
- **Stage 4 Fail (Test Critic)**: Retry via `tenet_retry_job` with explicit test-strengthening requirements from the critic.
- **Integration test Fail**: If the job is `report_only`, call `tenet_report_blocking_finding` with the observed finding, why it blocks the report, recommended follow-up, and likely target files. Otherwise retry the integration job with an enhanced prompt.
- **Retry policy**: Use `tenet_retry_job` while there is a concrete unresolved finding and the next attempt will use new evidence or a changed approach. Tenet defaults to unlimited retries; projects may configure a finite retry budget. If MCP reports a finite budget is exhausted, mark the job blocked. If failures stagnate, stop and report even when retries remain.

### Stage 5: Interaction E2E (Independent Job)

Dispatched as a separate `playwright_eval` job by `tenet_start_eval` alongside code critic and test critic. The job type remains `playwright_eval` for compatibility, but the worker first reads the exact run artifacts and project doctrine supplied through compiled context or `artifact_paths`, then classifies the declared e2e surface: browser UI, visual/canvas/game, CLI, API, library, or not applicable. The worker has independent context — does NOT see implementation code or author reasoning. Receives only the exact run artifacts, project doctrine, scenarios, and the running public surface.

For browser UI, game/canvas, visual, or other browser-interactive features, the worker MUST do BOTH layers unless the harness/spec explicitly marks Layer 2 optional or skipped with reason:

#### Layer 1: Scripted Playwright Tests (regression)
1. Locate existing Playwright test files (`tests/e2e/`, `e2e/`, `tests/playwright/`)
2. Ensure the application is running (start dev server or docker compose)
3. Run `npx playwright test` (or the project's test command)
4. Report pass/fail counts and any failing tests

#### Layer 2: Exploratory Agent-Driven Testing (Playwright MCP)
The worker uses Playwright MCP tools to interact with the app like a real user:
- `browser_navigate(url)` — go to a page
- `browser_click(selector)` — click buttons/links
- `browser_type(text)` / `browser_fill_form(...)` — enter text and fill form fields
- `browser_snapshot()` — inspect the accessibility snapshot and visible text
- `browser_take_screenshot()` — capture state visually
- `browser_evaluate(...)` — inspect page state when visible output is insufficient

**For each scenario in scope, the worker:**
1. Navigates to the entry point
2. Performs the user actions (click, fill, submit)
3. Takes screenshots at each step
4. Verifies the EXPECTED OUTCOME (not just absence of errors):
   - After login: did the URL change to /dashboard? Is user info visible?
   - After create: does the new item appear in the list?
   - After form submit: did it redirect to the correct page?
5. Tests edge cases scripted tests miss:
   - Click every button on every page
   - Try invalid inputs and verify error messages
   - Test navigation between pages
   - Verify all features in spec are reachable from the UI

#### Non-browser e2e
For CLI/API/library projects, do not force Playwright:
- CLI: run the public commands from scenarios and verify exit code, stdout/stderr, files, and side effects.
- API: run acceptance/integration tests or direct HTTP workflow checks declared in the harness.
- Library: run integration tests through the public API.
- No e2e surface: set `layer2_status: "not_applicable"` and report the reason from the harness/spec.

**What this catches that scripted tests miss:**
- Stats page implemented but not wired to navigation
- Buttons with wrong sizes or misaligned layouts
- Login form that submits but doesn't redirect correctly
- Copy button that doesn't actually copy to clipboard
- Broken CSS/styling that doesn't affect test assertions

**When Playwright MCP is not available:** If browser/visual Layer 2 is required, fail the eval. If the harness/spec says it is optional or skipped with reason, report "Playwright MCP not installed — exploratory testing skipped" and pass with Layer 1 results only. If browser exploration is not applicable, use the non-browser e2e path and report `layer2_status: "not_applicable"`.

**When the application won't start:** FAIL the eval. The application must start to be tested.

**PASS**: Scripted tests pass AND exploratory testing finds no issues.
**FAIL**: Any scripted test fails OR exploratory testing finds visual/behavioral bugs. Retry or report a blocking finding with screenshots and findings as evidence.

## Anti-Skip Enforcement
Evaluation is mandatory. Every job must pass Stage 1 and 1.5. Full mode runs every enabled critic — Stage 3 (code critic), Stage 4 (test critic), Stage 5 (interaction e2e), plus any custom critics enabled in `.tenet/critics.json`. All critics run in separate agent sessions with no access to the author's reasoning. The author cannot evaluate their own work.
