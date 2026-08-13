---
id: TASK-051
title: >-
  Follow-up fixes from PR #22 review: concurrency race, retry budget, skill
  alignment, test hardening
status: In Progress
assignee: []
created_date: '2026-08-13 23:01'
updated_date: '2026-08-13 23:08'
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
<!-- SECTION:NOTES:END -->
