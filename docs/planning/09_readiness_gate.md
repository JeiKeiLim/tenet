# 09 — Implementation Readiness Gate

**Created**: 2026-04-16
**Status**: Design
**Origin**: GitHub issue [#1 — Add a testing readiness gate before execution/eval](https://github.com/JeiKeiLim/tenet/issues/1)

---

## Motivation

Tenet gates interview clarity strictly (`tenet_validate_clarity`), but there is no gate between **spec/harness** and **decomposition** to check whether the agent has enough information to actually *build and verify* the feature. Missing prerequisites surface at execution or eval time, where failure is expensive:

- Missing external service credentials (LLM key, payment sandbox, webhook secret) → eval fails or silently mocks
- Missing app start command / env vars → playwright eval can't boot the app
- Missing third-party API contract knowledge → agent guesses endpoint shapes and fails late
- Missing test data / fixtures → integration tests are written but can't run meaningfully
- Missing research on library/algorithm choices → agent picks wrong tool, discovers mid-build

Issue #1 proposed a heavy solution (new artifact type, new directory, init scaffold changes, new phase instructions). This doc scopes a **minimal-machinery** version that addresses the same failure mode without adding a new document lane.

## What This Is NOT

Scaled back from the original issue:

- **No new artifact file.** No `.tenet/testing/{date}-{feature}.md`. Blockers are returned inline; agent resolves them by editing the existing spec and harness docs.
- **No `init` scaffold change.** No new `.tenet/testing/` directory.
- **No compile-context change.** If blockers are resolved in spec/harness, the existing `tenet_compile_context` already carries the info forward.
- **Not a clarity replacement.** `tenet_validate_clarity` stays as-is — it validates that user *requirements* are clear. This gate validates that *implementation prerequisites* are known.

## Design

### Tool

`tenet_validate_readiness` — modeled on `src/mcp/tools/tenet-validate-clarity.ts`. Dispatches a fresh agent to independently score whether the spec + harness (+ interview) contain enough implementation prerequisites. Returns pass/fail + blockers.

### When

After clarity passes, **before decomposition**. Hard block: decomposition should not proceed until readiness passes or blockers are explicitly mocked with reason.

### Scope (8 categories)

1. **Requirements/spec sufficiency** — ambiguities that survived clarity but matter at build time (error-handling policy, rate limits, edge case expectations); acceptance criteria concrete enough to write tests against.
2. **Research & prior art** — if the approach uses a specific library, algorithm, or protocol, has it been decided and read about? Known gotchas captured?
3. **Interface contracts** — API shapes, event schemas, DB tables pinned? Third-party API contracts (endpoints, auth flow, rate limits, error codes) understood before calling?
4. **External service access** — credentials for services the agent *calls but does not build* (LLM API keys, payment sandbox, webhook signing secrets, vendor sandbox accounts). **Not** for services the feature itself implements.
5. **Environment & runtime** — app start command, required env vars, local services/containers, ports, health-check/smoke path.
6. **Test data & fixtures** — seed users/records the agent can't synthesize (production-shaped data, real PDFs, real audio, sandbox accounts).
7. **Test strategy** — per layer (unit/integration/e2e): live, sandboxed, mocked, or skipped, with reason. **Includes non-UI verification** (logs, metrics, DB assertions, event-store queries) for features with async/background/third-party surfaces Playwright can't see.
8. **Dependencies & tooling** — required libs/runtimes confirmed installable; build/test commands runnable.

### Inputs

Reads (for the active feature):
- Latest `spec/{date}-{feature}.md`
- Latest `harness/current.md`
- Optionally `interview/{date}-{feature}.md` for context

### Return shape

```json
{
  "passed": false,
  "blockers": [
    "No LLM API key source specified (OpenAI key needed for summarization call in §3 of spec)",
    "App start command missing from harness"
  ],
  "missing_info": [
    "Rate limit behavior for the /summarize endpoint",
    "Seed dataset for embeddings test"
  ],
  "testable_surfaces": {
    "unit": "ready",
    "integration": "blocked",
    "e2e": "blocked"
  },
  "rationale": "Short explanation of what's missing and why it matters at build/test time."
}
```

- `blockers`: hard stops — must be resolved or explicitly mocked.
- `missing_info`: softer — agent should note but can proceed if not load-bearing.
- `testable_surfaces`: per-layer readiness so decomposition can adapt test job scope.

### Failure mode (escape hatch)

When `passed: false`, the agent must pick one:

1. **Supply the info** — edit spec/harness, re-run `tenet_validate_readiness`.
2. **Ask the user** — via `tenet_add_steer` or interactive prompt.
3. **Explicit mock with reason** — agent writes a "Mocked because…" note into the spec and re-runs; the validator accepts explicit mocks but should flag if *every* test layer is mocked (silent passing).

No silent continuation. No decomposition until readiness passes.

### Rubric (sketch)

The validator agent scores each of the 8 categories as `ready` / `partial` / `blocked`. Overall `passed` if no category is `blocked` for the feature's declared scope (a backend-only feature skips e2e; a UI-only feature skips external service access if none are declared).

The validator must not *invent* requirements. If the spec says "no external calls," it should not invent a need for an LLM key.

## Implementation Steps

1. **Design doc** — this file.
2. **Issue reply** — post scaled-down plan on #1 so the thread reflects reality.
3. **New tool**: `src/mcp/tools/tenet-validate-readiness.ts`, modeled on `tenet-validate-clarity.ts`.
   - Rubric constant with the 8 categories
   - Reads spec + harness + optional interview for the feature
   - Dispatches a fresh eval job
   - Returns `{ job_id }` so the caller awaits via `tenet_job_wait` + `tenet_job_result`
4. **Register** in `src/mcp/index.ts` alongside the other tools.
5. **Phase instructions** — update `skills/tenet/phases/02-spec-and-harness.md` (or add `03-readiness.md`) to instruct the agent to run `tenet_validate_readiness` after writing spec+harness, resolve blockers, and only then call `tenet_register_jobs`.
6. **SKILL.md** — document the new gate in the flow.
7. **Tests** — unit test for the tool (using `MockAdapter`) covering: pass case, block case, mock-acceptance case.

## Open Questions

- **Feature-scope declaration**: how does the validator know if e2e is in scope? Infer from harness ("e2e command present"), or require the spec to declare `testable_surfaces` explicitly? Leaning: infer, with explicit override possible.
- **Retry interaction**: on readiness failure, should the agent get an automatic retry budget (like dev jobs) or is it always user-in-the-loop? Leaning: user-in-the-loop — readiness failures usually require info the agent doesn't have.
- **Relationship to `tenet_start_eval`**: should eval jobs re-check readiness before firing, or trust the gate upstream? Leaning: trust upstream — eval failing on "missing creds" is the exact outcome the gate prevents.

## Expected Outcome

- Fewer late-stage eval failures from "missing prerequisite" category.
- Spec/harness docs become more complete as a side effect (agent has to answer the 8 categories).
- Less "implementation completed, testing impossible" failure mode observed in Round 5.

## Non-Goals

- Does not replace or extend clarity validation.
- Does not introduce a new document type.
- Does not gate Phase 1 (interview) or Phase 6 (implementation loop).
- Does not handle non-functional requirements (perf budgets, scale targets) — too rare at Tenet's typical feature size to gate on.
