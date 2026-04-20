# 11 — Auto-Testing Plan

**Created**: 2026-04-18
**Status**: Design
**Origin**: Plan 10 shipped with only unit tests; user flagged that we have no automated testing method we can trust. We can't keep relying on manual smoke runs.

---

## Motivation

Tenet's current test suite (65 tests as of plan 10) covers:

- Type-level correctness (TypeScript compiles)
- Unit logic on mocked adapters (job lifecycle, state-store CRUD, CLI config parsing)

It does NOT cover any of the following, which is where real bugs actually live:

1. **Prompt / output contract drift** — a critic's JSON wrapped in prose, a dev job that reports success but made no file edits, truncated streamed output. Unit tests with clean mock outputs never see this.
2. **Orchestration races** — the sequential-critic auto-dispatch chain (plan 10 part 1), remediation parent auto-resume (part 2), steer processing during long waits. Mocked tests run in milliseconds; real agents take minutes. Timing-sensitive bugs hide.
3. **Adapter argv correctness** — plan 10 part 4 added `extraArgs` insertion for three CLIs. Every position was guessed from docs. Never tested against real binaries.
4. **MCP tool registration drift** — a new tool added to `src/mcp/tools/index.ts` without being added to `TENET_MCP_TOOL_NAMES` means every first invocation prompts the user. The existing drift test is regex-based and brittle.
5. **Long-run emergent behavior** — a bug that only surfaces after 50 completed jobs because state accumulates. Manual testing can't reproduce this cheaply.

Tenet's core promise is "we orchestrate flaky agents into reliable outcomes." If we can't automatically verify that orchestrator is reliable, we're asking users to trust exactly what the product exists to solve. This document is the plan to close that gap.

## Non-goals

- **Full replacement of manual testing.** Some bugs (UX, skill-file clarity, error-message quality) are inherently subjective. We'll always want occasional human-in-the-loop runs.
- **Testing the agent CLIs themselves.** Claude Code, OpenCode, and Codex are black boxes. We test our interface to them, not their internals.
- **100% coverage metric chasing.** We want confidence in the critical paths, not a green statistics badge.
- **Rebuilding vitest.** Current unit tests stay. This plan adds layers above them, not instead of them.

## Design — Three Tiers

### Tier 1 — Contract tests with scripted fake agents (target: ship first)

**Goal:** Make the bugs in classes 1–3 above visible as red CI.

**Approach:** A `FakeAdapter` that implements `AgentAdapter` and reads its response from a scripted fixture file instead of spawning a CLI. The fixture encodes the *shape* of real agent output — including the annoying cases that broke us in plan 10.

**What the fixtures look like:**

```
tests/fixtures/fake-agents/
├── critic-passing-clean.json        # clean JSON, passed:true
├── critic-passing-fenced.md         # ```json block inside prose
├── critic-passing-trailing-prose.md # JSON followed by explanatory paragraph
├── critic-failing-with-findings.json
├── critic-truncated.txt             # JSON that got cut mid-token
├── dev-with-changes.md              # dev output + git-status hint
├── dev-without-changes.md           # dev output claiming success, no files
├── playwright-layer2-completed.json
├── playwright-layer2-skipped.json
├── playwright-layer2-failed.json
├── readiness-parallel-safe.json
├── readiness-parallel-unsafe.json
└── readiness-missing-field.json     # verdict key absent — must default sequential
```

**Scenarios each fixture proves:**

| Fixture shape | Assertion |
|---|---|
| `critic-passing-fenced.md` | `extractRubricJson` strips fences; chain advances to next critic |
| `critic-passing-trailing-prose.md` | Regex finds JSON even with prose after |
| `critic-truncated.txt` | Chain halts gracefully; parent is NOT auto-resumed |
| `dev-without-changes.md` | `checkDeliverables` flags missing changes; job fails |
| `playwright-layer2-skipped` | `latest_playwright_layer2_status` surfaces "skipped_no_mcp" |
| `readiness-missing-field` | `eval_parallel_safe:{feature}` is NOT written; start-eval falls back to sequential |
| `readiness-parallel-unsafe` | Config is written; start-eval chains via parentJobId |

**New test file:** `src/core/integration.test.ts` — spins up a real `StateStore` + `JobManager` + `AdapterRegistry(FakeAdapter)`, runs one full job cycle end-to-end per scenario, asserts DB state.

**Scope ceiling:** ~20–30 scenarios, all running in <5s on CI. Adding new ones is one fixture file + one test block.

**Investment:** ~1 day to build `FakeAdapter` + fixture harness + 10 seed scenarios. Thereafter cheap to grow.

**What Tier 1 catches:**
- Every class-1 logic regression (existing unit tests keep doing this).
- Every class-2 prompt/parsing drift bug (the critical gap today).
- Most class-3 orchestration bugs, except those requiring real timing.

**What Tier 1 does NOT catch:**
- Actual agent-CLI incompatibilities (argv, auth, model availability).
- True concurrent-execution races (FakeAdapter returns synchronously).
- Long-run state accumulation.

### Tier 2 — Nightly E2E against one real agent (target: land after Tier 1 is stable)

**Goal:** Catch class-4 bugs (adapter argv, CLI contract drift, MCP registration drift at runtime).

**Approach:** A single end-to-end test that exercises the full loop against a real agent. Pick the cheapest + fastest adapter — likely Claude Code CLI with Haiku, though this becomes a config knob.

**The canary project:** a tiny scaffolded app in `tests/e2e/canary-project/` — something like a 3-endpoint Express API or a 2-page static site. Small enough that one dev job implements it in <2 minutes, cheap enough that a full cycle costs cents, stateful enough that `eval_parallel_safe=false` is the expected verdict.

**The test script** (`tests/e2e/full-loop.e2e.ts`):

1. Copy canary project to a temp dir.
2. Run `tenet init --yes --agent claude-code` (exercises plan 10 part 5).
3. Write a spec + harness (pre-canned, not agent-generated).
4. Call `tenet_validate_readiness` — assert verdict JSON contains `eval_parallel_safe`.
5. Register a 2-job DAG via `tenet_register_jobs`.
6. Run the loop: `tenet_continue → start_job → job_wait → job_result → start_eval → wait → result` for each job.
7. Assert at each step:
   - MCP tools are callable (no silent registration regressions).
   - Dev job produced git-tracked changes.
   - Critics emitted parseable JSON.
   - `tenet_get_status` returns the expected shape (including `latest_playwright_layer2_status`).
8. Teardown.

**CI integration:** Runs nightly on `main`, NOT on every PR. Blocks release tagging. Failure auto-creates a GitHub issue labeled `e2e-regression`.

**Budget:** ~10–20 minutes per run, ~$0.50 per run at Haiku pricing. ~$15/month for daily runs. Trivial for the signal it provides.

**Investment:** ~1 day for harness + canary project + GitHub Actions workflow. Ongoing API budget.

**What Tier 2 catches:**
- Adapter argv misalignment with real CLI.
- `tenet init` permission/trust merges that don't actually silence prompts.
- Registration regressions where we ship a broken MCP tool that looked fine in unit tests.
- Real-world JSON output shapes we didn't think to fixture in Tier 1.

**What Tier 2 does NOT catch:**
- Long-run emergent bugs (one cycle ≠ 200 cycles).
- Behavior on the other two adapters (deliberately scoped to one to keep cost down).

### Tier 3 — Replay harness from captured runs (target: after first production bug report)

**Goal:** Regression-test against real historical runs when users hit edge cases.

**Approach:** Every completed Tenet run leaves `.tenet/.state/tenet.db` + `.tenet/journal/*.md`. A replay harness accepts one of these captures and re-runs the orchestrator's decision logic event-by-event, asserting that new code makes the same (or better) decisions.

**New tool:** `tenet replay <path-to-captured-db>` — a dev-only CLI subcommand that:

1. Opens the captured SQLite in read-only mode.
2. For each job event in order, calls the current job-manager's decision functions (`continue()`, `dispatchChainedChildren`, `checkRemediationResume`, etc.) with the historical inputs.
3. Prints a diff of "what the old code did" vs. "what the new code would do."
4. Exits non-zero if the new code would produce a regression (stuck job, wrong status transition, missed auto-resume).

**Use cases:**
- User reports "my 200-job run stalled at job 47." Grab their DB, replay on main, reproduce the stall locally.
- Before merging a job-manager refactor, replay the last 10 captured runs. Zero regressions = confident merge.
- Build a test corpus from flagged runs over time. `pnpm run test:replay` iterates the corpus.

**Privacy note:** Captured DBs may contain prompts / spec content with sensitive project info. The harness runs locally only. We don't ship captures in the repo; users submit them only via private channels when reporting bugs.

**Investment:** ~2 days. Pays back the first time it prevents a regression in a big refactor.

**What Tier 3 catches:**
- Subtle behavioral regressions in orchestrator logic.
- Bugs that only surface with specific DAG shapes / job ordering.
- Long-run emergent issues (by replaying entire runs, not single jobs).

**What Tier 3 does NOT catch:**
- Bugs in unreplayable code paths (adapter invocation, MCP tool registration, CLI flag parsing).

## Tier Interactions

```
┌──────────────────────────────────────────────────────────────────┐
│ Tier 1: Fake-agent contract tests                                │
│   Runs: every PR, <5s                                            │
│   Catches: prompt parsing, orchestration glue, 90% of regressions│
└──────────────────────────────────────────────────────────────────┘
           ↓ passing tier 1 is precondition for merge
┌──────────────────────────────────────────────────────────────────┐
│ Tier 2: Real-agent nightly E2E                                   │
│   Runs: nightly on main, ~15min, ~$0.50                          │
│   Catches: adapter argv, CLI contract, init merge correctness    │
└──────────────────────────────────────────────────────────────────┘
           ↓ passing tier 2 for 3 consecutive nights is a release precondition
┌──────────────────────────────────────────────────────────────────┐
│ Tier 3: Replay harness                                           │
│   Runs: ad-hoc + pre-refactor + grown corpus                     │
│   Catches: behavioral regressions, long-run bugs                 │
└──────────────────────────────────────────────────────────────────┘
```

## What Changes — Concrete File List

### Tier 1 (Week 1)

- `src/adapters/fake-adapter.ts` — **new.** Reads a fixture path from its constructor, returns that content as `AgentResponse`. Supports scripted multi-call sequences for chain tests.
- `tests/fixtures/fake-agents/*.{json,md,txt}` — **new.** Initial 10 fixtures covering the scenarios above.
- `src/core/integration.test.ts` — **new.** Spins up real JobManager + StateStore + FakeAdapter, runs one end-to-end scenario per fixture, asserts on DB state.
- `src/core/integration-helpers.ts` — **new (small).** Shared test harness: `createIntegrationHarness(fixture: string)` returning `{store, manager, cleanup}`.

### Tier 2 (Week 2)

- `tests/e2e/canary-project/` — **new.** Minimal scaffolded app (Express or Vite) with spec + harness pre-written.
- `tests/e2e/full-loop.e2e.ts` — **new.** End-to-end test script (not under vitest — standalone Node script).
- `.github/workflows/nightly-e2e.yml` — **new.** GitHub Actions workflow: runs at 03:00 UTC daily, uses `ANTHROPIC_API_KEY` secret, files an issue on failure.
- `docs/e2e-runbook.md` — **new.** How to reproduce the E2E test locally when it fails in CI.
- `package.json` — add `test:e2e` script.

### Tier 3 (ad-hoc, after first production bug)

- `src/cli/replay.ts` — **new.** `tenet replay <db-path>` subcommand.
- `src/cli/index.ts` — register `replay` command.
- `tests/replay/` — **new directory.** Captured DB corpus (git-ignored; manifest file lists known-good snapshots with origin notes).
- `package.json` — add `test:replay` script.

### Supporting changes (all tiers)

- `Makefile` — add `test:all` target that runs `test` + `test:integration` (Tier 1). `test:e2e` stays out of Makefile default — manual invocation only.
- `README.md` — add a "Testing" section describing the three tiers and when each runs.
- `.gitignore` — add `tests/replay/captures/` (captured DBs may contain user content).

## Success Criteria

### Tier 1 done when:
- `pnpm run test:integration` runs in <10s on CI.
- At minimum these scenarios are covered (one fixture each):
  - Critic JSON parsing: clean / fenced / trailing-prose / truncated (4 fixtures).
  - Auto-dispatch chain: 3 sequential critics complete → chain advances → parent resumes.
  - Remediation auto-resume: child dev → 3 critics pass → parent flips pending.
  - Readiness verdict persistence: ready-parallel / ready-sequential / missing-field (3 fixtures).
  - Layer2 status surfacing: completed / skipped / failed (3 fixtures).
- A new contributor can add a scenario with ~10 lines of test + one fixture file.

### Tier 2 done when:
- Nightly workflow runs green for 7 consecutive days on `main`.
- Injecting a deliberate regression (e.g., break `extractRubricJson`) causes the next nightly to fail and auto-file an issue.
- Cost under $20/month at current CI cadence.

### Tier 3 done when:
- `tenet replay <db>` produces a human-readable diff of decisions.
- At least one real bug has been reproduced locally via replay and fixed.
- Corpus has grown to ≥5 captured runs covering varied DAG shapes.

### Overall done when:
- A contributor landing a change touching `src/core/job-manager.ts` or `src/mcp/tools/` without updating or adding tests feels the friction of red CI, not "I hope this works."
- Releases are tagged only after tier 1 + tier 2 are green.

## Sequencing

1. **Tier 1 first.** Biggest coverage gap, cheapest to build, unblocks everything else. Target: 1 week after this doc is approved.
2. **Tier 2 second.** Only after Tier 1 is stable — otherwise Tier 2 failures are noisy (Tier 1 should catch them first). Target: 1 week after Tier 1 lands.
3. **Tier 3 lazy.** Build the minimum replay tool after the FIRST production bug report that we can't reproduce with Tier 1+2. Don't speculate — let a real need shape the API.

## Open Questions

- **Which adapter for Tier 2?** Claude Code with Haiku is the plan; depends on API cost / rate limits. Worth a one-week cost measurement before committing.
- **Does Tier 1 need per-adapter variants?** The fake adapter is adapter-agnostic. Adapter-specific bugs (argv) only show in Tier 2. Probably fine to keep Tier 1 adapter-agnostic.
- **Corpus privacy for Tier 3.** If users submit captured DBs, how do we strip sensitive content? Likely: document that captures for public corpus must have prompts replaced with synthetic text, and keep private captures in a separate non-shared location.

## Out of Scope

- Property-based testing of job-manager state machine (fuzzing job transitions). Maybe later — current bug density doesn't justify the tooling cost yet.
- Mutation testing to grade unit tests. Same reasoning — not the bottleneck today.
- Performance benchmarks / SLO tests. We don't have user-reported perf issues yet.
- Cross-platform CI matrix (Windows, Linux). macOS-on-CI matches most users today; revisit if Windows users show up.

## Known Gaps This Plan Does NOT Address

Documented honestly so we don't pretend:

- **Claude Code, OpenCode, Codex CLI changes can still silently break us.** Tier 2 catches this nightly, but between a release and the next nightly run, a user could hit a regression. Mitigation: Tier 2 runs before every release tag, not just nightly.
- **We'll still miss bugs on adapter combinations we don't test.** Tier 2 uses one adapter. Cross-adapter bugs exist (e.g., a fix that works for Claude breaks for OpenCode). Accepted trade-off — cost-multiplying by 3 isn't worth it until we see the bug class.
- **Tier 1's fake adapter is a model of reality, not reality.** If the fixture shapes drift from what real agents emit, Tier 1 passes but real usage fails. Mitigation: every time Tier 2 catches a bug, add a Tier 1 fixture that matches the real shape that broke.
