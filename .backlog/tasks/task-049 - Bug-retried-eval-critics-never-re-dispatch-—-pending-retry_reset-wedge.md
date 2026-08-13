---
id: TASK-049
title: 'Bug: retried eval critics never re-dispatch — pending/retry_reset wedge'
status: In Progress
assignee: []
created_date: '2026-08-12 22:04'
updated_date: '2026-08-12 22:30'
labels:
  - bug
  - eval
  - dispatch
dependencies: []
references:
  - >-
    /Users/limjk/GitHub/JeiKeiLim/podcast-gen-web-service/.tenet/knowledge/2026-08-12_retried-eval-critics-never-re-dispatch-wedge.md
priority: high
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SERVER BUG (observed 2026-08-12, podany observability run): a critic reset via tenet_retry_job never gets re-dispatched. It sits at status=pending / pending_reason=retry_reset / elapsed_ms=0 forever; the dispatch loop never picks it up, tenet_continue() surfaces only DAG jobs (never the retried critic), and no job timeout fires because elapsed_ms stays 0 (timeouts apply to running jobs only). Children queued_after_parent behind it never dispatch either, so the whole eval chain wedges.

REPRO / TIMELINE (UTC 2026-08-12):
- 14:13 eval-tracking sub-agent spawned; J9 dev job completed (commit 4c6913f); tenet_start_eval dispatched 9 critics sequentially (eval_parallel_safe=false).
- ~14:47 code_critic + test_critic passed. interaction_e2e (ae798cda) ran, failed with an environment-level api_error 400 'this model does not support image input' (critic took a screenshot; the host model cannot ingest images).
- ~14:56 sub-agent called tenet_retry_job(ae798cda, enhanced_prompt=no-image-input) — the documented remediation.
- 14:57 -> 21:57 (7 HOURS): retried critic stuck pending/retry_reset/0s elapsed. Sub-agent polled correctly every ~2 min the entire time; polling was NOT the problem.
- 21:58 orchestrator workaround: cancelled the 7 wedged/queued non-running critics, re-ran tenet_start_eval on the completed job with the same output passed through. Fresh eval chain dispatched immediately (code_critic started instantly).

CONTRAST: the earlier queued_after_parent stall (J8 run) was fixed by retrying the failed parent — that retry DID dispatch. Here, even the retried critic itself never dispatches, so the retry-reset path is broken in a different way.

IMPACT: ~7h wall-clock lost on one eval; sub-agent token budget burned polling a structurally-unstartable job; the eval had to be re-run from scratch (re-running already-passed code_critic + test_critic). Any run that retries a failed critic is exposed to this.

SUGGESTED FIX DIRECTION: (1) dispatch loop should pick up pending jobs with pending_reason=retry_reset (same as queued_after_parent whose parent completed); or (2) retry_reset should re-queue the job for immediate dispatch rather than relying on a poller that skips it; or (3) tenet_continue() / job_wait should surface retry_reset jobs as dispatchable. Add an integration test: fail a critic, tenet_retry_job it, assert it reaches running within N seconds.

WORKAROUND (validated): cancel the wedged critic + all non-running children (they are all status=pending, elapsed_ms=0), then re-run tenet_start_eval with the same output. Fresh dispatch works. Also: eval-tracking sub-agent delegation prompts should include wedge detection — if a retried critic stays pending/0s elapsed >3-5 min, message the orchestrator instead of waiting.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Integration test: fail a critic -> tenet_retry_job -> assert the retried job reaches running (not stuck pending/retry_reset) within a bounded time
- [x] #2 Dispatch loop (or equivalent) picks up retry_reset pending jobs whose parent is terminal
- [x] #3 Regression guard: a retried critic that wedges surfaces in tenet_continue or job_wait as actionable instead of silently pending
- [ ] #4 Integration test: fail a critic -> tenet_retry_job -> assert the retried job reaches running (not stuck pending/retry_reset) within a bounded time; retryJob re-dispatches the retried job immediately (run-now) so a retried job never sits pending/retry_reset awaiting a poller that doesn't exist; Regression guard: B3 integration test asserts a retried critic reaches running and completes within bounded time
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. retryJob() auto-dispatches immediately after reset (retry = run-now, consistent with tenet_start_job({job_id})). 2. Update tenet_retry_job tool description + response (status: running, next_tool hint). 3. Update README table row + unit test (retried job is now running, not pending). 4. Integration test in src/core/integration.test.ts: fail a critic -> retry -> reaches running within bounded time (AC#1). 5. Queue-servicer concept filed as separate backlog task.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decided with user 2026-08-13: retry = run-now (philosophy 1). The queue-servicer (philosophy 2) is a larger architectural question — filed separately.

FIX IMPLEMENTED + VERIFIED 2026-08-13: retryJob() now calls dispatchJob() after the reset (run-now). Updated tenet_retry_job tool description + response (next_tool: tenet_job_wait), README + CLAUDE.md rows. Unit test updated (retried job status is running, not pending). New B3 integration test in src/core/integration.test.ts: fail interaction_e2e via FakeAdapter (success:false maxUses:1) -> tenet_retry_job -> status running immediately -> completes within 5s. Full suite: 354 tests / 29 files pass; typecheck + eslint clean.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-12 22:15
---
VALIDATED WORKAROUND (2026-08-12 21:59 UTC): tenet_start_job(job_id=<wedged job>) force-dispatches a pending retry_reset critic — it goes straight to running with its stored enhanced prompt. Proven on interaction_e2e 60b54c27 (fresh-eval wedge): retried -> stuck pending/retry_reset/0s -> tenet_start_job(job_id) -> RUNNING. No cancels, no eval re-run, no re-triggered image-wall cost. This should be the primary unblock; the cancel+rerun path is the fallback. Suggested fix direction update: tenet_start_job(job_id) working implies the dispatcher CAN run the job — the bug is that the dispatch loop never claims retry_reset jobs on its own. Consider making the loop claim them (or surfacing them as start_job-eligible without a manual call).
---

created: 2026-08-12 22:30
---
Queue-servicer (philosophy 2: one place decides what runs next) deferred to a separate backlog task — needs more design discussion before building. Current fix is run-now (philosophy 1).
---
<!-- COMMENTS:END -->
