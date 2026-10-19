---
id: TASK-057
title: >-
  Shared evidence ledger for eval critics — dedupe mechanical checks within a
  round
status: Done
assignee: []
created_date: '2026-10-19 02:22'
updated_date: '2026-10-19 02:40'
labels: []
dependencies: []
modified_files:
  - src/mcp/tools/tenet-start-eval.ts
  - src/mcp/tools/tenet-start-eval.test.ts
  - skills/tenet/critics.md
  - skills/tenet/phases/06-evaluation.md
  - CLAUDE.md
priority: high
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

During eval rounds with multiple critics (3 built-ins + customs), each critic independently re-runs the same repo-wide mechanical checks (unit suite, lint, build, typecheck). Observed in a real run: every custom critic ran the exact same unit tests with no code modification between them. Verified cause: each critic is dispatched with only its own prompt + job scope + the implementation output (`src/mcp/tools/tenet-start-eval.ts`) — no critic sees what any other critic ran. On the fixed code state of one eval attempt, duplicate runs are pure waste: sequential/hybrid rounds pay N × suite-time in wall clock, and every round pays N × suite cost in tokens.

## Settled design (from maintainer discussion — do not re-litigate)

1. **Per-round append-only JSONL ledger**, one file per `tenet_start_eval` dispatch:
   `.tenet/runs/<run-slug>/critics/evidence/eval-<source-job-id>-<eval_round>.jsonl`
   - `eval_round` is the existing TASK-056 stamp: one `randomUUID()` per `tenet_start_eval` call, fresh on every re-fire. No new id machinery.
   - Entry shape: `{"check": "...", "command": "...", "exit_code": N, "output_excerpt": "...", "recorded_by": "<stage>"}` — mechanical facts only; never findings, verdicts, or judgments. **Never a `passed` key**: rubric.ts's `findRightmostPassedObject` scans right-to-left for any boolean-`passed` object, so a verdict-shaped entry echoed in a critic's output could be misparsed as its verdict and false-green the gate.
2. **`tenet_start_eval` inserts a "Shared Evidence Ledger" block into every dispatched critic's prompt** (built-ins + customs, grounded + ungrounded), between the job scope and the critic's own mission text so every critic's end-shape stays byte-identical to pre-ledger prompts. Block rules (hardened after adversarial review):
   - Consult-first for repo-wide mechanical checks only; a missing/unreadable file is an empty ledger (you may be the first runner); ledger IO is non-fatal — never fail or stall the eval over it.
   - Skeptical, excerpt-bounded citation: cite only if the entry's `output_excerpt` plainly shows the outcome its `exit_code` claims, and only for what the excerpt supports (a report field needing more detail — per-test results, specific failures — re-runs).
   - Re-run on conflicting entries, doubt, contradiction, or unparsable/partial/oversized lines (never reconstruct a partial entry).
   - Staleness rule: if the repo's code changed during the round (`git rev-parse HEAD` no longer matches the commit under evaluation — the block embeds the SHA extracted from the worker output as anchor — or newer commits are visible), treat every entry as stale and re-run.
   - Append after running: exactly one physical line, escaped newlines/quotes, ~300-char excerpt cap, never full logs, never a `passed` key.
   - Framing: optional dedupe, never a gate; if unclear, run every check yourself and append nothing — always safe.
3. **Best-effort, zero coordination**: no locks, no first-runner election, no ordering. Concurrent duplicate runs are accepted. Interleaved appends may drop a line — cost is one duplicate run later.
4. **The orchestrator/planner never reads the ledger.** Routing stays findings/categories. Strictly critic-to-critic.
5. **Freshness (corrected after adversarial review)**: within-round reuse is sound under the execution loop's dev-then-eval serialization, and the TASK-056 critic-retry safeguard keeps an in-place critic retry on the same ledger file only while no code-writing job has completed since round dispatch. That serialization is orchestrator convention, not enforcement — sibling dev jobs can complete mid-round — so the block carries the explicit staleness rule above instead of asserting freshness as fact. Cross-round leakage is structurally impossible: a source retry, re-fire, or contention re-run is a new dispatch → fresh `eval_round` → fresh ledger file.
6. **Ad-hoc source jobs** (no `run_path` in params): no ledger block (the ledger is a run artifact).
7. `tenet_start_eval` creates the evidence directory (mkdir recursive) at dispatch; a mkdir failure degrades to no block (today's behavior) rather than failing the eval.

## Why this preserves critic independence

The author/critic separation is about reasoning, not redundant execution. The ledger shares raw commands + exit codes; judgment, findings, and verdicts remain per-critic. The hallucination-amplification risk (one critic logging a false "pass" that later critics cite) is bounded by the skeptical-citation rules: readers cite only excerpts that plainly support the claimed exit code, re-run on doubt or conflict, and re-run when a mid-round code change is observable — today a single hallucinated "tests pass" is outvoted by siblings' real runs, and those same siblings' fresh entries out a fabricated one.

## Accepted residuals (from adversarial design review)

- In-flight tree mutations (a dev job RUNNING across the round, orphan-reset or stall-failed jobs leave edited files with no completion event) are baseline-equivalent fuzziness — today a late critic's fresh run hits the same transient tree. Accepted like dropped appends; the SHA anchor covers the completion case.
- Blocking-finding follow-up dev children are started ad-hoc (no `run_path`), so fix-the-code evals get no ledger block — consistent with item 6, though it mirrors the motivating case.
- `tenet_retry_job` with an `enhanced_prompt` replaces the critic's prompt wholesale, dropping the block; as-is retries keep it (documented in `skills/tenet/critics.md`).

## Non-goals

No new MCP tools, no DB schema change, no `.tenet/critics.json` schema change, no orchestrator-side coordination or ledger parsing.

## Related

- TASK-047 (hybrid critic lanes — the ledger pays off most where chained critics serialize; chain order makes the first runner's entries visible to the rest)
- TASK-056 (eval_round stamp + critic-retry safeguard — the retry-path freshness bound)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every critic dispatched by tenet_start_eval (3 built-ins + customs, grounded or ungrounded) whose source job has a run_path receives a Shared Evidence Ledger block naming the deterministic round ledger path
- [x] #2 All critics in one tenet_start_eval dispatch share one eval_round and therefore one ledger path; a new dispatch (source retry, re-fire, contention re-run) produces a fresh path
- [x] #3 Source jobs without run_path (ad-hoc jobs) receive no ledger block
- [x] #4 The evidence directory .tenet/runs/<run-slug>/critics/evidence/ exists after dispatch
- [x] #5 Unit tests cover block presence, per-round path sharing, fresh path per dispatch, no-run_path skip, and dir creation; make check passes
- [x] #6 Docs updated: skills/tenet/critics.md, skills/tenet/phases/06-evaluation.md, CLAUDE.md .tenet conventions
- [x] #7 No new MCP tools, no DB schema change, no .tenet/critics.json schema change
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. `src/mcp/tools/tenet-start-eval.ts` — generate `evalRound` before critic prompt assembly; read the source job's `run_path`; build the Shared Evidence Ledger block (project-relative path + consult-first / append-after / conflict-rerun rules, entries-as-data); append it to every dispatched critic prompt (built-ins + customs); mkdir the evidence dir when run_path exists.
2. Unit tests in `src/mcp/tools/tenet-start-eval.test.ts` — block presence on all critic kinds, one shared path per dispatch, fresh path per new dispatch, no block without run_path, dir creation, block placement does not disturb the critic's output-contract line.
3. Docs: `skills/tenet/critics.md` (the block is automatic — what custom-critic authors should assume), `skills/tenet/phases/06-evaluation.md` (ledger semantics in the critic-lanes context), `CLAUDE.md` (.tenet conventions: `critics/evidence/`).
4. Gate: `make check` green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Started implementation. Adversarial design-verification workflow (4 lenses: staleness, poisoning, prompt-shape, integration) running against the settled design before code changes land.

Adversarial design review (4 lenses, 505k tokens) returned 14 findings, 0 blockers. Folded in: (1) mid-round code-change staleness rule with commit-SHA anchor extracted from worker output — the TASK-056 safeguard only polices tenet_retry_job, so within-round freshness is convention, not enforcement; (2) skeptical excerpt-bounded citation so one fabricated entry cannot become round-wide belief; (3) missing-file/first-runner + partial-line + oversized-entry handling; (4) e2e Layer-1 per-test reporting exempted from blind citation; (5) never-a-passed-key rule (rubric verdict-parser false-green path); (6) never-a-gate framing with run-everything fallback for weak models; (7) placement between job scope and critic body confirmed correct by independent analysis. Docs and block wording de-overclaimed accordingly.

Final-diff review (3-dimension adversarial workflow: code/tests, docs consistency, design fidelity): 0 confirmed defects, 3 notes — all folded in. (1) Block's covered-checks enumeration now includes scripted e2e suites (npx playwright test), aligning with 06-evaluation.md's dedup-wins claim; critics.md parenthetical aligned. (2) Best-effort block presence now documented (critics.md bullet + 06-evaluation.md): a failed evidence-dir mkdir degrades to no block (pre-ledger behavior). (3) Fixed leftover overclaim in critics.md: 'All critics... evaluate the same fixed code state' -> 'normally... — the execution loop serializes dev and eval'. Gate re-run after fixes: make check green (31 files / 402 tests).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
tenet_start_eval inserts a Shared Evidence Ledger block into every dispatched critic prompt (built-ins + customs, grounded + ungrounded) when the source job has a run_path: per-round append-only ledger at .tenet/runs/<run-slug>/critics/evidence/eval-<source-job-id>-<eval_round>.jsonl (eval_round = existing TASK-056 stamp), evidence dir created at dispatch (mkdir failure degrades to no block), commit-SHA staleness anchor extracted from the worker output, hardened rules (skeptical excerpt-bounded citation, never a passed key, never a gate, run-everything fallback). Ad-hoc sources get no block; orchestrator never reads the ledger. 7 new unit tests (eval tool suite 30). Docs: skills/tenet/critics.md, skills/tenet/phases/06-evaluation.md, CLAUDE.md. Design survived a 4-lens adversarial review (14 findings folded in); final diff survived a 3-dimension review (0 confirmed, 3 notes folded in). make check green: 402 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
