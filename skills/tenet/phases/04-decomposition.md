# Phase 04: DAG Decomposition & Status Tracking

## 1. Objectives
- Decompose the Product Specification into a Directed Acyclic Graph (DAG) of executable jobs.
- Generate executable acceptance test stubs from the scenarios defined in the spec.
- Insert integration test checkpoints at natural DAG boundaries.
- Initialize the status tracking system to manage the execution flow via MCP.

**Before producing the DAG, read the spec's front-matter `delivery_mode` field** (see `phases/02-spec-and-harness.md` § 2.1).

- `delivery_mode: autonomous` (or absent) → produce one full component DAG covering the whole feature, as described in Sections 4–6 below.
- `delivery_mode: agile` → produce **only the next slice's DAG**, register it, and stop. Section 9 below overrides the single-pass behavior. Decomposition will fire again per slice as the user advances through use-checkpoints.

For Full mode runs with an interview transcript, verify the spec front-matter `delivery_mode` matches `## Delivery Mode Decision` in the transcript. If the transcript decision is missing or mismatched, stop before acceptance tests, decomposition, or job registration; return to the relevant crystallization phase. Pre-execution confirmation cannot retroactively satisfy delivery-mode selection.

Before decomposition, verify required visual artifacts exist when the feature has a user-facing or interactive surface (UI, game/canvas, visual app, TUI, CLI workflow, API workflow, or similar). If required visuals are missing, stop and run `phases/03-visuals.md` before writing the DAG.

## 2. File Structure (STRICT)
- **DECOMPOSITION**: `.tenet/decomposition/{date}-{feature}.md` (e.g. `.tenet/decomposition/2026-04-08-oauth.md`)
- **ACCEPTANCE TESTS**: `tests/acceptance/` directory with test files generated from scenarios
- **JOB QUEUE**:     `.tenet/status/job-queue.md` (auto-generated from DB)
- **BACKLOG**:       `.tenet/status/backlog.md`
- **STATUS**:        `.tenet/status/status.md` (auto-generated from DB)

Use the same `{feature}` slug established during the interview phase. `{date}` is today's ISO date (YYYY-MM-DD).

## 3. Acceptance Test Generation (BEFORE decomposing into jobs)

Before writing the DAG, generate executable acceptance tests from the spec scenarios. These tests define "done" — they must pass for the project to be complete.

### Rules:
- Write tests BEFORE any implementation exists — they will fail initially, and that's expected
- Each scenario from `.tenet/spec/scenarios-{date}-{feature}.md` becomes at least one test
- Anti-scenarios become tests that verify the bad behavior does NOT happen
- Tests must be runnable with a single command

### CRITICAL: Verify Outcomes, Not Absence of Errors

Tests must assert that the **correct thing happened**, not just that nothing crashed. A test that checks "no error was thrown" will pass even when the feature is completely broken.

**Bad** (passes even if login is broken):
```typescript
test('login flow', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'user@test.com');
  await page.fill('#password', 'password123');
  await page.click('button[type="submit"]');
  // ❌ This passes even if login redirects back to /login
  await expect(page).not.toHaveURL(/error/);
});
```

**Good** (fails if login doesn't actually work):
```typescript
test('login flow', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'user@test.com');
  await page.fill('#password', 'password123');
  await page.click('button[type="submit"]');
  // ✅ Verify we landed on the dashboard, NOT back on login
  await expect(page).toHaveURL(/dashboard/);
  // ✅ Verify authenticated content is visible
  await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
  // ✅ Verify session persists across reload
  await page.reload();
  await expect(page).toHaveURL(/dashboard/);
});
```

**Assertion checklist for every test:**
- After form submit → verify redirect URL is the **expected destination** (not the same page)
- After create → verify the created item **appears in a list/view**
- After login → verify **authenticated content loads** and **session persists across reload**
- After any state change → verify the **new state is visible to the user**

### Brownfield Feature Discovery

For brownfield projects, do NOT only test features mentioned in the spec. Before writing tests:
1. Read the brownfield scan (`.tenet/bootstrap/codebase-scan.md`) if it exists
2. Search the codebase for routes, pages, API endpoints, and interactive elements
3. List ALL discoverable features and generate tests for each
4. The user cannot be expected to enumerate every existing feature during the interview

### For projects with a frontend (UI):
Use Playwright. Create `tests/acceptance/{feature}.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';

// From Scenario 1: [scenario name]
test('[user action] → [expected outcome]', async ({ page }) => {
  await page.goto('/path');
  // Fill forms, click buttons, verify results
  await expect(page).toHaveURL(/expected/);
});
```

Also create `playwright.config.ts` if it doesn't exist. Include setup for starting the dev server.

### For API-only projects:
Use the project's test framework (vitest, jest, etc.). Create `tests/acceptance/{feature}.test.ts`:
```typescript
// From Scenario 1: [scenario name]
test('[API call] → [expected response]', async () => {
  const res = await fetch('http://localhost:PORT/api/endpoint', { method: 'POST', body: ... });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty('expected_field');
});
```

### For CLI/library projects:
Write integration tests that exercise the public API end-to-end.

## 4. Decomposition Format
The decomposition file must include:
- **ASCII DAG**: Visual representation of job dependencies, including integration checkpoints.
- **Job Details**: For each job, specify ID, type (`dev` or `integration_test`), dependencies, deliverables, and verification criteria.
- **Interface Contracts**: Define data/state boundaries between dependent jobs.

## 5. Integration Test Checkpoints (MANDATORY)

Insert `integration_test` type jobs at natural boundaries in the DAG:

### When to insert checkpoints:
- After a **feature area** is complete (e.g., after all auth-related jobs finish)
- After **backend + frontend** for the same feature are both done
- Before any job that builds on top of another feature (verify the foundation works first)
- As the **final job** in the DAG (full end-to-end verification)

### Example DAG with checkpoints:
```
job-1: Core API ──────────────┐
job-2: Auth Service ──────────┤
                       e2e-1 (verify API + auth work together)
                              │
job-3: Frontend ──────────────┤
job-4: Dashboard ─────────────┤
                       e2e-2 (full e2e: signup → login → use features)
```

### Integration test job definition:
```json
{
  "id": "e2e-1",
  "name": "Integration: API + Auth",
  "type": "integration_test",
  "depends_on": ["job-1", "job-2"],
  "report_only": true,
  "prompt": "Run acceptance tests for API and auth features. Start the server, run tests/acceptance/auth.spec.ts and tests/acceptance/shorten.spec.ts. Report which tests pass and fail."
}
```

**Integration test jobs do NOT fix code.** They only report results. Register report-only verification jobs with `report_only: true` so they can use `tenet_report_blocking_finding` when they discover blocking findings.

## 6. Job Registration

Call `tenet_register_jobs` with all jobs including integration checkpoints and the exact artifact paths that passed readiness:
```
tenet_register_jobs({
  feature: "oauth",
  artifact_paths: {
    spec: ".tenet/spec/2026-04-08-oauth.md",
    harness: ".tenet/harness/current.md",
    scenarios: ".tenet/spec/scenarios-2026-04-08-oauth.md",
    interview: ".tenet/interview/2026-04-08-oauth.md",
    decomposition: ".tenet/decomposition/2026-04-08-oauth.md"
  },
  jobs: [
    { id: "job-1", name: "Core API", type: "dev", depends_on: [], prompt: "..." },
    { id: "job-2", name: "Auth Service", type: "dev", depends_on: ["job-1"], prompt: "..." },
    { id: "e2e-1", name: "Integration: API + Auth", type: "integration_test", depends_on: ["job-1", "job-2"], report_only: true, prompt: "Run acceptance tests for..." },
    { id: "job-3", name: "Frontend", type: "dev", depends_on: ["e2e-1"], prompt: "..." },
    { id: "job-4", name: "Dashboard", type: "dev", depends_on: ["e2e-1"], prompt: "..." },
    { id: "e2e-2", name: "Final E2E", type: "integration_test", depends_on: ["job-3", "job-4"], report_only: true, prompt: "Run ALL acceptance tests..." }
  ]
})
```

Do not rely on feature-only document lookup for new runs. The registered jobs carry `artifact_paths` into `tenet_compile_context`, so implementation workers read the same spec/harness/scenarios/interview/decomposition that passed the readiness gate.

## 7. Execution Protocol (CRITICAL)
1. **Write Acceptance Tests First**: Generate test stubs from scenarios before writing the DAG.
2. **Write Decomposition**: Create the DAG with integration checkpoints.
3. **Register Jobs**: Call `tenet_register_jobs` with all jobs. Jobs after integration checkpoints depend on the checkpoint.
4. **Pre-execution confirmation**: After registration, stop and present the execution summary:
   - delivery mode
   - feature slug
   - total jobs registered
   - job list with dependencies
   - integration checkpoints
   - key spec decisions
   - harness constraints
5. **Wait for explicit confirmation** before calling `tenet_continue()` or `tenet_start_job`. Valid confirmation means the user responds after seeing the execution summary with approval such as `confirm`, `start`, `go`, `approved`, or equivalent. The original project request does not count as pre-execution confirmation; confirmation must happen after decomposition/job registration.
6. **Enter MCP Loop**: If confirmed, read `phases/05-execution-loop.md`, then use `tenet_continue()` to get the next ready job and `tenet_start_job` to dispatch it.
7. **No Bypassing**: Do NOT start executing until acceptance tests are written, decomposition is complete, jobs are registered, and pre-execution confirmation is satisfied.
8. **Small Batches**: Every dev job must be completable in one agent session with clear verification.

## 8. Verification
- [ ] Acceptance test files exist in `tests/acceptance/` (or equivalent)
- [ ] DAG includes at least one `integration_test` checkpoint
- [ ] Final job in DAG is an `integration_test` that runs all acceptance tests
- [ ] All jobs are registered via `tenet_register_jobs`
- [ ] Pre-execution summary was presented and the user explicitly confirmed after seeing it
- [ ] In agile mode: only the current slice's jobs are registered; the decomposition file has a `## Slice N: ...` heading for this fire

## 9. Agile-mode decomposition (when `delivery_mode: agile`)

This section overrides the single-pass behavior of Sections 4–7 when the spec's front matter declares `delivery_mode: agile`. Read the spec's `## Slice plan` first.

### 9.1 Per-slice decomposition (one fire per slice)

In agile mode, decomposition fires **once per slice**, not once per feature:

- The first fire happens immediately after the initial plan-checkpoint passes. Output: slice 1's DAG.
- Each subsequent fire is triggered by a use-checkpoint (`approve` advances to the next slice) or by the redirect router after readiness re-passes. Output: the next slice's DAG.
- Decomposition reads the spec's `## Slice plan` to know which slice is next. Skip slices already marked complete.

Each fire produces:

- A small DAG for the **next un-built slice**
- A trailing `integration_test` job that runs the slice's acceptance tests
- One `tenet_register_jobs` call with the slice's jobs

Do NOT register every slice's jobs upfront. The DB only sees the current slice; the upfront plan lives in the spec.

### 9.2 Slice DAG shape

Each slice's DAG follows the same patterns as the autonomous DAG (dev jobs with dependencies, ending in an integration_test). Differences:

- The slice's DAG must end in **a runnable, eval-passing application state**, not just "this component compiles." The user has to actually use the app at the use-checkpoint.
- The slice's `integration_test` job runs the **slice's relevant acceptance tests** (cumulative — slices 1..N), not the whole project's. Use the slice plan's `User can` field to scope test selection.
- Slice N's first dev job depends on slice N-1's `integration_test` job. This serializes slice execution and creates the natural gate for use-checkpoints. (Slice 1 has no such dependency.)

### 9.3 File accumulation (single doc, slice-headed sections)

`.tenet/decomposition/{date}-{feature}.md` is **appended**, not rewritten, on each slice fire. Use slice-headed sections so the whole feature's decomposition lives in one file:

```markdown
# Decomposition for {feature}

## Slice 1: {slice name}
[ASCII DAG, job details, interface contracts for slice 1]

## Slice 2: {slice name}
[ASCII DAG, job details, interface contracts for slice 2]

...
```

This mirrors the spec's slice-headed structure and keeps `tenet_compile_context`'s "latest by date prefix" globbing working unchanged.

### 9.4 Acceptance test handling

Acceptance tests are still generated upfront from the spec's scenarios (Section 3 unchanged). On top of that:

- Tag each test by slice. Two acceptable conventions:
  - **File-level**: `tests/acceptance/slice-1-login.spec.ts`
  - **Test-level**: a `// slice: N` comment near each test, plus a Playwright/Vitest tag (e.g., `test('...', { tag: '@slice-1' }, ...)`)
- Slice N's `integration_test` job runs the tests tagged for slices 1..N (additive, mirroring the slice plan).
- When a redirect adds a new test, append under the relevant slice tag. Do NOT rewrite existing test files.

### 9.5 Job ID convention

Use slice-prefixed job IDs so logs and status output stay grouped:

- Dev jobs: `slice-{N}-{descriptor}` (e.g., `slice-1-auth-api`, `slice-1-login-ui`)
- Integration test: `slice-{N}-e2e`

This is a naming convention only — no schema change to `tenet_register_jobs`.

Example registration (slice 1 of an SNS app):

```js
tenet_register_jobs({
  feature: "sns-app",
  jobs: [
    { id: "slice-1-auth-api", name: "Auth API", type: "dev", depends_on: [], prompt: "..." },
    { id: "slice-1-signup-ui", name: "Signup UI", type: "dev", depends_on: ["slice-1-auth-api"], prompt: "..." },
    { id: "slice-1-login-ui", name: "Login UI", type: "dev", depends_on: ["slice-1-auth-api"], prompt: "..." },
    { id: "slice-1-e2e", name: "Integration: slice 1 (login + signup)", type: "integration_test",
      depends_on: ["slice-1-signup-ui", "slice-1-login-ui"],
      report_only: true,
      prompt: "Run acceptance tests tagged @slice-1. Start the server, run tests/acceptance/slice-1-*.spec.ts. Report pass/fail." }
  ]
})
```

When slice 2 fires later, the registration call would include only slice-2-* jobs, with `slice-2-*-first` depending on `slice-1-e2e`.

### 9.6 What does NOT change

- Section 3 (acceptance test generation from scenarios) — tests are still generated upfront, still mandatory. Tagging by slice is the only addition.
- Section 5 (integration test checkpoints) — still required; agile mode just adds per-slice granularity on top.
- Section 7 (execution protocol) — same MCP loop within a slice. The orchestrator's checkpoint pauses (steps 4 and 5 of the agile rollout) sit *outside* the MCP loop, between slice fires.
- Per-job eval (critic + test critic + playwright_eval, defined in `phases/06-evaluation.md`) fires on every job, in both modes.
