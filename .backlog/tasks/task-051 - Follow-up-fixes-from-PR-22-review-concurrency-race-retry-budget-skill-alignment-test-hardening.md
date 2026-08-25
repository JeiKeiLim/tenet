---
id: TASK-051
title: >-
  Follow-up fixes from PR #22 review: concurrency race, retry budget, skill
  alignment, test hardening
status: In Progress
assignee: []
created_date: '2026-08-13 23:01'
updated_date: '2026-08-24 22:22'
labels:
  - bug
  - eval
  - dispatch
  - architecture
dependencies: []
priority: high
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up work from the two review workflows on PR #22 (retry = run-now). PR #22 fixed the retry_reset wedge (retryJob now dispatches immediately). Two review workflows surfaced 9 + 22 confirmed findings. Decisions made with user 2026-08-13:

1. CONCURRENCY RACE (review #1/#9, medium): retryJob's reset-then-dispatch is non-atomic across multiple MCP server processes sharing tenet.db. Two processes retrying the same job interleave: both reset to pending + increment retryCount, first dispatch wins, second throws after committing its increment (or both schedule executeJob -> double adapter invocation). FIX (user approved BOTH): (a) conditional reset — UPDATE ... WHERE status IN ('completed','failed'), 0 rows affected means another process already retried -> return current job without dispatching; (b) idempotent dispatchJob — return the running job instead of throwing when already running (also makes tenet_start_job on a running job a no-op).

2. RETRY BUDGET (review #5, low): retrying a COMPLETED job increments retryCount, so intentional re-runs can exhaust a finite budget and block a later genuine failure retry. FIX (user approved): reset retryCount to 0 on completion (executeJob success path). A re-run that fails still counts (correct). Note: this changes budget semantics from per-job-lifetime to per-failure-streak.

3. SKILL ALIGNMENT (review #4 + alignment workflow, 22 confirmed): skill prompts were not updated for run-now. Consolidated edit list:
   - 05-execution-loop.md:38,46 — backoff must be applied BEFORE tenet_retry_job (job starts the moment the tool is called); add post-retry tenet_job_wait step; note retried job is running, not pending, and continue() won't return it as next_job.
   - 05-execution-loop.md:114 — sub-agent eval-tracking: post-retry wait; do NOT call tenet_start_job on retried critic.
   - 05-execution-loop.md:205-235 (HIGH) — finding-category dispatch calls tenet_retry_job once per finding; with run-now the first call dispatches (running) and a second finding's retry THROWS 'can only retry completed or failed jobs'. Consolidate ALL findings into ONE retry call, then wait + re-eval.
   - 06-evaluation.md:11,156-159 — run-now note in retry policy + finding-categories table (wait with tenet_job_wait, re-run tenet_start_eval, won't reappear as next_job).
   - SKILL.md:190,192 — one-line run-now note (backoff before call, wait after, start_job throws).
   - tenet-retry-job.ts:12 — reword '(same effect as tenet_start_job on the job id)' parenthetical (misreadable as 'you can also call start_job' which now throws).
   - Historical/dated planning docs: leave unchanged (5 findings).

4. TEST HARDENING (review #2/#3/#6/#7/#8): B4 middle-critic retry (chain continuation after retry); enhanced_prompt end-to-end assertion; unit test await completion (no dangling executeJob); guard-edge tests (non-terminal jobs, finite-budget-at-limit); parallel-mode retry + retry->resume-gate interaction (retried critic's pass unblocking a blocked_on_finding parent).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
IMPLEMENTED + VERIFIED 2026-08-13 (make check green, 362 tests):
- Concurrency: StateStore.resetJobForRetry() atomic conditional update (WHERE status IN completed/failed); retryJob returns current job if another process won; dispatchJob idempotent on running.
- Budget: retryCount resets to 0 on completion (executeJob success path).
- Tests: 6 new unit tests (budget reset, idempotent dispatch, atomic reset, guard edges, enhanced_prompt end-to-end via adapter.lastInvocation) + B4 (middle-critic retry chain continuation) + C1b (retried critic pass unblocks blocked parent).
- Skills: 05-execution-loop.md (lines 38/46/114/205-235), 06-evaluation.md (11/159), SKILL.md (190/192), tenet-retry-job.ts description reworded. Historical planning docs left unchanged.
- Generated .claude/skills + .agents/skills copies are per-project (tenet init), not tracked here — no sync needed.

ROUND 3 (follow-up review, 23 confirmed) — implemented + verified 2026-08-13 (make check green, 363 tests):
- resetJobForRetry: retry_count = 0 for completed jobs (CASE), +1 for failed — fixes false 'previous attempt failed' preamble on re-runs.
- dispatchJob: atomic pending->running via markJobRunning (conditional UPDATE) — closes dispatch TOCTOU.
- Finding-category dispatch: scope_conflict+report_only checked FIRST (escape hatch can't be skipped); backoff-before-call + wait-loop notes.
- Skill docs: start_job on running job = harmless no-op (was 'throws'); SKILL.md bullets merged.
- Tests: budget test updated, new preamble test, enhanced_prompt replacement assertion.
- SKIPPED (user decision, rare edges): lost-race enhanced_prompt drop (#3), budget-check race (#4). ACCEPTED: CLI retry marker lost on completed jobs (#7).

LOOP STATUS (round 46, 2026-08-19): 45 review rounds since PR #22. Product code stable since round-4 (retry auto-dispatch, atomic dispatch, budget semantics unchanged). Last ~15 rounds are almost entirely low/nit findings on the dispatch-contract test (regex edge cases: comment-satisfiability, boundary tolerance, same-call pinning) and cross-doc phrasing consistency (steer comment / eval-mode reminder / 06 table / critics.md / planning doc 10). Confirmed counts oscillate 5-12 rather than converging to zero — the fundamental limit of regex-pinning agent-executed pseudocode in a skill doc (content tests are either brittle or vacuous). Assessment: remaining findings are 'truly trivial' (test-brittleness nits, contrived future-edit scenarios), no product-code defects since round-4. Recommend declaring convergence after the round-46 verdict and handing PR #22 to human review.

DRIFT TRIM (2026-08-25, user review of 31-finding drift audit) — several behaviors drifted during the ~45 review rounds and were reversed. Commit b01fbc3 on fix/retry-job-redispatch:
- RETRY BUDGET (was item #2 + ROUND-3 line 1): REVERTED to original semantics. retry_count now increments on EVERY retry, completed or failed (resetJobForRetry: retry_count = retry_count + 1, no completed-job CASE). Budget gate applies always: a completed job with exhausted budget throws, re-runs are NOT exempt. The "reset retryCount to 0 on completion" change was serious drift and is gone; completion no longer resets retry_count. User: "this needs to be reverted to the original behavior".
- START_JOB NO-OP (was item #1b, ROUND 3 line 4): REVERTED ON-B. dispatchJob no longer returns the running job; the loud "job X is running, expected pending" throw is restored. The atomic race fix is KEPT: resetJobForRetry WHERE status IN (completed,failed) guard + markJobRunning pending->running WHERE status=pending. So: two processes retrying the same job still cannot double-dispatch; a second explicit dispatch on a running job now throws again.
- REPORT-ONLY ESCALATION (B8): KEPT. report-only jobs escalate non-retryable categories via tenet_report_blocking_finding.
- FINDING-CATEGORY DISPATCH (item #3 HIGH): OPTION B. The per-finding retry loop is replaced by a loop that BUILDS one consolidated instructions list, then ONE tenet_retry_job call with enhanced_prompt (a second retry on a running job throws).
- PLANNING DOC (C#8): KEPT — eval_parallel_safe:{feature} is written ONLY by the readiness gate (no MCP tool wrote it), so the old doc-override was impossible; the fix is honest.
- CONTRACT TEST: skill-dispatch-contract.test.ts DELETED. It was a unit test solely pinning skill-doc prose via regex; that was the drift engine. User: "then it should be gone".
- Skill docs trimmed to match (05-execution-loop.md budget sentence + sub-agent bullet + finding-dispatch block, 06-evaluation.md run-now note, SKILL.md retry bullet, tenet-retry-job.ts description).
- Verified: vitest 372 pass, tsc --noEmit clean, eslint clean.
- PR #22 now scoped to: retry = run-now (run-now), concurrency race hardening (atomic reset + atomic running-claim), report-only escalation, skill alignment, budget/original semantics. READY for human review.
<!-- SECTION:NOTES:END -->
