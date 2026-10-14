---
id: TASK-047
title: Hybrid critic dispatch mode — parallel then sequential
status: Done
assignee: []
created_date: '2026-07-15 08:02'
updated_date: '2026-10-14 06:59'
labels:
  - tenet
  - enhancement
dependencies: []
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Currently critics run either fully sequential or fully parallel. Add a hybrid mode where critics marked as parallel_safe run concurrently first, then remaining sequential critics run after. This saves wall-clock time when a mix of independent and dependent critics exist.

Key design questions:
- How to mark a critic as parallel_safe vs sequential? Config-level flag? Per-critic metadata?
- What about critics that are parallel_safe but share a resource (DB, rate-limited API)?
- Should the orchestrator auto-detect parallelism (no shared resources) or require explicit marking?
- How does this interact with eval_parallel_safe:{feature} config key?
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 .tenet/critics.json entries accept optional parallel_safe; explicit values override built-in defaults (code_critic=true, test_critic=false, interaction_e2e=false); custom critics default false (sequential opt-in)
- [x] #2 Verdict eval_parallel_safe:{feature}=true dispatches ALL critics in parallel, per-critic flags ignored — identical to today
- [x] #3 Verdict false/missing dispatches hybrid: parallel_safe critics start concurrently; the rest chain among themselves in roster order (existing auto-dispatch chain); lanes overlap — neither waits for the other
- [x] #4 execution_mode reports parallel/sequential/hybrid accurately including degenerate lane cases
- [x] #5 Round bookkeeping intact: expected_eval_stages covers every dispatched critic regardless of lane; eval_round cohort stamping and the TASK-056 critic-retry safeguard unchanged
- [x] #6 Skills docs updated: critics.md roster field, 02-spec-and-harness (readiness semantics + Critic Tailoring), 05-execution-loop, 06-evaluation
- [x] #7 make check green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. critic-roster.ts: parallel_safe on CriticRosterEntry → parallelSafe on ResolvedCritic; BUILTIN_DEFAULT_PARALLEL_SAFE map; explicit overrides built-in defaults; customs default false. 2. tenet-start-eval.ts: verdict true → all startJob (unchanged); verdict false/missing → partition dispatchList: parallel lane all startJob, sequential lane head startJob + rest chained via createPendingJob + auto_dispatch_on_parent_complete; execution_mode tri-state + per-job lane; tool description update. 3. Tests: roster resolution; start-eval hybrid shapes (default roster on missing verdict is now hybrid: code ∥ test→e2e; all-sequential roster; all-parallel roster; verdict-true ignores flags); integration B1/B3/B4 updated to hybrid. 4. Skill docs. 5. make check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PARK (2026-10-13 cleanup audit): gate on the measure-first rule - no run data shows sequential eval costing meaningful time. Today no per-critic parallel_safe field exists (src/core/critic-roster.ts:75-97) and dispatch is strictly binary (src/mcp/tools/tenet-start-eval.ts:474-498). Close as wont-do if the design questions yield no contention-free split.

Unparked 2026-10-14: maintainer supplied the measurement the PARK note gated on (5-10 critics per round, sequential rounds >1h). Design settled with maintainer: field name parallel_safe (exercises_app rename proposed and rejected as confusing). AND-rule: a critic serializes only when its parallel_safe is not true AND the feature verdict is false/missing. Lanes overlap — the sequential chain never waits for the parallel wave and vice versa. Verdict=true keeps byte-identical all-parallel behavior.

Implementation record (2026-10-14): critic-roster.ts — CriticRosterEntry.parallel_safe (optional bool) resolves to ResolvedCritic.parallelSafe via BUILTIN_DEFAULT_PARALLEL_SAFE {code_critic: true, test_critic: false, interaction_e2e: false}; explicit values override built-ins (same pattern as full_context); customs default false (explicit opt-in). tenet-start-eval.ts — verdict true: all startJob, flags ignored (byte-identical to today). Verdict false/missing: single-pass partition of dispatchList preserving roster order in jobs[]; parallel lane startJob, sequential lane head startJob + rest createPendingJob(..., auto_dispatch_on_parent_complete: true, prevId) chained (existing dispatchChainedChildren machinery, zero new dispatch code). Lanes overlap by design — a parallel_safe critic's contract is 'contends with nothing', so no barrier is needed. execution_mode tri-state: parallel (no sequential), sequential (no parallel), hybrid; response adds per-job lane, parallel_critics/sequential_critics counts; lifecycle distinguishes queued_after_parent. Tests: critic-roster 19/19 (new resolution test), tenet-start-eval 23/23 (hybrid default-roster shape code ∥ test→e2e, verdict-true ignores flags, all-sequential, 5-critic hybrid, degenerate parallel), integration 42/42 (C6 rewritten for hybrid round-2: chained head runs immediately, parent stays blocked until LAST chained critic completes). Docs: critics.md, 02-spec-and-harness (readiness section + §4.5 register step), 05-execution-loop (:41, :112, eval-mode reminder), 06-evaluation (Parallel/Hybrid/Sequential section). make check green: clean+build+typecheck+lint+test, 31 files 395 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hybrid critic dispatch shipped: per-critic parallel_safe roster field (built-in defaults code=true, test/e2e=false, customs opt-in) composes AND-style with the readiness verdict — verdict true keeps today's all-parallel dispatch untouched; verdict false/missing splits into overlapping lanes (parallel_safe critics concurrent, the rest chain in roster order via the existing auto-dispatch chain), with execution_mode reporting parallel/hybrid/sequential plus per-job lane. Verified: make check green (395 tests), including new hybrid dispatch shapes and round-bookkeeping integration cases.
<!-- SECTION:FINAL_SUMMARY:END -->
