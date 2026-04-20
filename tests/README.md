# Tenet Tests

Two layers today:

- **Unit tests** — scattered across `src/**/*.test.ts`. Fast, mocked, cover per-file logic.
- **Tier 1 integration tests** (`src/core/integration.test.ts`) — run the real JobManager + StateStore + MCP tool handlers against a scripted `FakeAdapter`. Exercise the same parsers and dispatchers that run in production; swap only the agent CLI. See [`docs/planning/11_auto_testing_plan.md`](../docs/planning/11_auto_testing_plan.md).

## Adding a Tier 1 scenario

### 1. Drop a fixture

Create a file under `tests/fixtures/fake-agents/` that matches what a real agent would emit. The fixture is returned verbatim as `AgentResponse.output` — do not pre-parse.

Examples of realistic shapes:

- Clean JSON: `{"passed": true, ...}`
- JSON inside ```json fences surrounded by prose
- JSON followed by an explanatory paragraph
- Truncated streams (no closing brace)
- Free-form prose with no JSON at all

Name the file so the intent is obvious (`critic-passing-fenced.md`, `dev-without-changes.md`).

### 2. Add a scenario

In `src/core/integration.test.ts`, write an `it(...)` block using the existing `createHarness` helper:

```ts
it('my scenario: one-sentence claim being tested', async () => {
  const { store, manager } = createHarness([
    { match: matchers.evalStage('code_critic'), fixture: 'my-fixture.md' },
  ]);

  const job = manager.startJob('critic_eval', {
    source_job_id: 'dummy',
    eval_stage: 'code_critic',
    prompt: 'Code Critic — whatever prompt triggers the matcher',
  });
  await manager.waitForJob(job.id, null, 5_000);

  expect(store.getJob(job.id)?.status).toBe('completed');
});
```

Rules of thumb:

- **Always await `waitForJob`** on every job you start. Otherwise setTimeout-scheduled callbacks fire against a closed DB after teardown.
- **Prefer `matchers.*`** (`matchers.evalStage`, `matchers.devJob`, `matchers.promptContains`) over writing predicates inline — keeps the ruleset readable.
- **Assert against DB state**, not against your own mock bookkeeping. The point of Tier 1 is that the real orchestrator's decisions land in the real store.

### 3. Confirm the test catches a regression

Before declaring a scenario useful, temporarily break the code path it's supposed to cover and confirm the test goes red. If the test still passes with the code broken, it wasn't testing what you thought.

## What NOT to do

- **Don't mock the parsers.** If you pre-parse the fixture and feed structured data in, you're testing the fixture loader, not `extractRubricJson`.
- **Don't assert timing.** `FakeAdapter` returns instantly; tests that check "critic A finished before critic B" are nondeterministic.
- **Don't put live API keys in fixtures.** Fixtures are committed to the repo. If a fixture represents "agent hit the Anthropic API successfully", the response must still be synthetic.

## When Tier 1 isn't enough

Tier 1 can't catch:

- Adapter argv issues against real CLIs.
- MCP tool registration regressions at runtime.
- Long-run emergent bugs.

Those are Tier 2 (nightly E2E) and Tier 3 (replay harness) — not built yet. See the planning doc.
