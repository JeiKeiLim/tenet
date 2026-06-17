# E2E Canary Runbook

This is the **manual Tier 2** harness — end-to-end canaries that drive a real agent CLI through a full Tenet cycle. Not automated, not in CI. You run them when you want high-confidence signal before shipping or after a risky change.

See `docs/planning/11_auto_testing_plan.md` for the full three-tier strategy.

## What each canary exercises

| Target | Canary | Tenet path exercised |
|---|---|---|
| `make e2e-cli` | key-count CLI | readiness with `eval_parallel_safe=true` → parallel critics |
| `make e2e-api` | note-store API | readiness with `eval_parallel_safe=false` → sequential critics |
| `make e2e-web` | click-counter HTML | Playwright eval Layer 2 reporting path |
| `make e2e-agile` | 2-slice agile CLI | per-slice registration and slice progress status |
| `make e2e-agile-full` | agent-driven agile pipeline | planning prompt produces agile spec, decomposition, and slice jobs |
| `make e2e-all` | all five sequentially | full coverage of the canary paths |

## Prerequisites

1. **A logged-in agent CLI on your machine.** Whatever you use day-to-day — `claude`, `opencode`, or `codex`. The harness uses whatever `tenet config --agent` is set to in this repo.
2. **Node ≥ 20** (same as the rest of the project).
3. **`pnpm install`** has been run at least once.
4. **No ANTHROPIC_API_KEY needed** for local use — the CLI handles auth.

## Cost / time estimates (per run)

Rough. Actual varies with how much the agent iterates.

| Canary | Wall time | Agent calls | Sonnet 4.6 | Haiku 4.5 |
|---|---|---|---|---|
| CLI | 5-10 min | ~5 | $0.30-0.80 | $0.05-0.15 |
| API | 10-15 min | ~8 | $0.50-1.20 | $0.08-0.25 |
| Web | 8-12 min | ~6 | $0.40-1.00 | $0.07-0.20 |
| Agile CLI | 10-15 min | ~8 | $0.50-1.50 | $0.10-0.30 |
| Agile full pipeline | 20-30 min | ~12 | $0.50-2.50 | $0.15-0.50 |
| All | 55-80 min | ~40 | $0.80-6.50 | $0.30-1.70 |

Switch to a cheaper model globally via `tenet config --opencode-args "--model ..."` or your agent's equivalent before running, if cost is a concern.

## Running

```bash
make e2e-cli          # quickest smoke
make e2e-api          # stateful-app path
make e2e-web          # static + playwright-eval path
make e2e-agile        # per-slice agile path
make e2e-agile-full   # agent-driven agile planning path
make e2e-all          # all five
```

### Choosing a specific agent

The harness uses whatever `tenet config --agent` is set to in this repo by default. To override for a single run **without touching the repo's config**:

```bash
TENET_E2E_AGENT=claude-code make e2e-cli
TENET_E2E_AGENT=opencode    make e2e-cli
TENET_E2E_AGENT=codex       make e2e-cli
```

Useful for exercising each adapter's CLI contract separately — `claude-code` hits the `claude` adapter's argv, `opencode` hits `opencode run` (the one that motivated plan 10 part 4), and `codex` hits `codex exec --sandbox workspace-write` unless configured args override sandboxing. A finding on one but not another usually points at adapter-specific wiring.

The harness prints timestamped progress. Each job shows up as "cycle N: dispatching <job-name>" followed by "eval dispatched (sequential|parallel)". Agents take minutes per call; console looks idle for long stretches. That's normal.

## What a pass looks like

```
[12:04:11] [cli] workdir: /var/folders/.../tenet-e2e-key-count-abc123
[12:04:11] [cli] agent: claude-code
[12:04:12] [cli] initProject done
[12:04:12] [cli] validate_readiness start
[12:06:48] [cli] readiness verdict: eval_parallel_safe=true
[12:06:48] [cli] register_jobs: 1 jobs
[12:06:48] [cli] cycle 1: dispatching implement key-count CLI
[12:11:23] [cli] eval dispatched (parallel)
[12:13:17] [cli] running verify...
[12:13:18] [cli] verify passed: passed 4 checks: ...
 ✓ E2E canary: key-count CLI > builds a working CLI from spec+harness  (589012ms)
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

## When a canary fails

The test prints the full `CanaryResult` JSON on failure. First things to check:

1. **`failures[]`** — the harness-level reason. Could be "dev job did not complete", "not all critics completed", or "verify failed: <details>".
2. **Inspect the workdir** — rerun with the `keepWorkdir` option. Easiest way: set it temporarily in `tests/e2e/canary-*.e2e.test.ts` and rerun. Then `cd` into the printed path and look at:
   - `.tenet/runs/<run-slug>/journal/` — failure journals from the agent.
   - `.tenet/.state/tenet.db` — `sqlite3 ... "SELECT id, type, status, error FROM jobs"`.
   - Actual source files the agent produced (or didn't).
3. **Common real-bug signals:**
   - `verify failed: dist/...js missing after tsc fallback` → agent wrote TS but forgot `tsc`; harness/spec likely needs stronger build step.
   - `not all critics completed: completed, failed, completed` → one critic flat-out errored; check its output in the DB.
   - `readiness job did not complete: failed` → readiness prompt is too long or the agent's auth lapsed.
4. **Common false-bug signals:**
   - Network hiccups, rate limits. Retry before investigating.
   - Agent CLI newly auto-updated in the background and auth expired.

## Interpreting Tenet-specific outcomes

The harness only asserts the outer loop worked. **The interesting bugs are inside**: did the agent actually follow the spec? Did the critics catch real issues? Did the remediation escape hatch trigger appropriately?

To answer those, read:

- The final `.tenet/status/status.md` for the completed workdir.
- Each job's `output` in `tenet.db` — the critic findings tell you what the critic thought.
- The `eval_parallel_safe:<feature>` config value — confirms the readiness gate picked the right mode.

## Known limitations

- **Only one agent is exercised per run.** Cross-adapter bugs (e.g., a fix that works for Claude Code breaks OpenCode) won't show up. Switch the repo's default agent and rerun if you need multi-adapter coverage.
- **No Playwright MCP required unless the harness says so.** The web canary's Layer 2 exploratory testing needs Playwright MCP installed only when browser exploration is declared required. Otherwise Layer 2 can report `skipped_no_mcp`; non-browser projects should report `not_applicable` and run their declared CLI/API/library e2e checks.
- **maxCycles caps at 5.** If a canary spec is large enough to need more dev jobs (it shouldn't be — they're canaries), raise `maxCycles` in the test file.

## Updating a canary

Canary files live in `tests/e2e/canaries/<slug>/`:

- `spec.md` — what the agent is asked to build.
- `harness.md` — the project's quality contract.
- `jobs.json` — the DAG (usually 1 job).
- `jobs/slice-N.json` — per-slice DAG files for agile canaries.
- `prompt.md` — raw planning prompt for the full-pipeline agile canary.
- `verify.ts` — post-run smoke check.

Keep specs tight. If a canary starts taking >15 minutes consistently, the spec has grown too large — split it or simplify.
