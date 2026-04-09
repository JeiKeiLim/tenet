# Phase 04: DAG Decomposition & Status Tracking

## 1. Objectives
- Decompose the Product Specification into a Directed Acyclic Graph (DAG) of executable jobs.
- Generate executable acceptance test stubs from the scenarios defined in the spec.
- Insert integration test checkpoints at natural DAG boundaries.
- Initialize the status tracking system to manage the execution flow via MCP.

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
  "prompt": "Run acceptance tests for API and auth features. Start the server, run tests/acceptance/auth.spec.ts and tests/acceptance/shorten.spec.ts. Report which tests pass and fail."
}
```

**Integration test jobs do NOT fix code.** They only report results. If they fail, the orchestrator creates fix jobs.

## 6. Job Registration

Call `tenet_register_jobs` with all jobs including integration checkpoints:
```
tenet_register_jobs({
  feature: "oauth",
  jobs: [
    { id: "job-1", name: "Core API", type: "dev", depends_on: [], prompt: "..." },
    { id: "job-2", name: "Auth Service", type: "dev", depends_on: ["job-1"], prompt: "..." },
    { id: "e2e-1", name: "Integration: API + Auth", type: "integration_test", depends_on: ["job-1", "job-2"], prompt: "Run acceptance tests for..." },
    { id: "job-3", name: "Frontend", type: "dev", depends_on: ["e2e-1"], prompt: "..." },
    { id: "job-4", name: "Dashboard", type: "dev", depends_on: ["e2e-1"], prompt: "..." },
    { id: "e2e-2", name: "Final E2E", type: "integration_test", depends_on: ["job-3", "job-4"], prompt: "Run ALL acceptance tests..." }
  ]
})
```

## 7. Execution Protocol (CRITICAL)
1. **Write Acceptance Tests First**: Generate test stubs from scenarios before writing the DAG.
2. **Write Decomposition**: Create the DAG with integration checkpoints.
3. **Register Jobs**: Call `tenet_register_jobs` with all jobs. Jobs after integration checkpoints depend on the checkpoint.
4. **MCP Loop**: After registration, use `tenet_continue()` to get the next ready job, then `tenet_start_job` to dispatch it.
5. **No Bypassing**: Do NOT start executing until acceptance tests are written, decomposition is complete, AND jobs are registered.
6. **Small Batches**: Every dev job must be completable in one agent session with clear verification.

## 8. Verification
- [ ] Acceptance test files exist in `tests/acceptance/` (or equivalent)
- [ ] DAG includes at least one `integration_test` checkpoint
- [ ] Final job in DAG is an `integration_test` that runs all acceptance tests
- [ ] All jobs are registered via `tenet_register_jobs`
