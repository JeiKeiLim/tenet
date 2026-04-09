# Phase 6: Evaluation

The evaluation pipeline ensures that all implemented work meets both mechanical requirements and the original intent. It enforces a strict separation between the author and the critic to prevent leniency.

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

If tests are insufficient, the test critic outputs specific tests that need to be added or strengthened. These become requirements for a fix job before the integration checkpoint can pass.

## Integration Test Evaluation

Integration test jobs (`integration_test` type) have a different eval flow:
1. The integration test agent runs acceptance tests and reports results
2. If ALL tests pass → job completes successfully
3. If ANY test fails → job fails with detailed failure report
4. On failure, the orchestrator creates targeted fix jobs for each failure
5. After fix jobs complete, the integration test is retried

The orchestrator should parse the integration test output to identify specific failures and create focused fix jobs rather than retrying the entire feature.

## Evaluation Result Format
Record results via `tenet_update_knowledge` with a descriptive title. Example: `title="eval project-scaffold mechanical-and-spec-compliance"`. The tool generates a dated markdown file in `.tenet/knowledge/`.

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
- **Stage 1/1.5 Fail**: Fix the mechanical/runtime issue immediately.
- **Stage 3 Fail (Code Critic)**: Run reflection to find the root cause, then retry via `tenet_retry_job` (preferred) or create a new job if the approach is fundamentally wrong.
- **Stage 4 Fail (Test Critic)**: Create a fix job to add/strengthen the tests identified by the critic, then re-run the integration checkpoint.
- **Integration test Fail**: Create targeted fix jobs, then retry the integration test.
- **Limits**: Max 3 retries per job before marking it as blocked.

## Anti-Skip Enforcement
Evaluation is mandatory. Every job must pass Stage 1 and 1.5. Full mode requires Stage 3 (code critic) and Stage 4 (test critic). Both critics run in separate agent sessions with no access to the author's reasoning. The author cannot evaluate their own work.
