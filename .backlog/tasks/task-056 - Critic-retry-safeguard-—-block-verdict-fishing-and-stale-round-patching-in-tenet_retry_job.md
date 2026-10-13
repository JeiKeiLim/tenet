---
id: TASK-056
title: >-
  Critic retry safeguard — block verdict-fishing and stale-round patching in
  tenet_retry_job
status: Done
assignee: []
created_date: '2026-10-13 22:22'
updated_date: '2026-10-13 23:46'
labels:
  - critics
  - eval
  - mcp
  - reliability
dependencies: []
priority: medium
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`tenet_retry_job` re-runs any completed/failed job — including critics — for any reason. Retry = run-now (`job-manager.ts:303`, `retryJob` ends in `dispatchJob`; shipped as PR #22 / 0b2a2d2) and keeps the job id + params, so the critic's `eval_round` survives and a patched round can green without re-running its siblings (round gate, `job-manager.ts:1067-1152`). Nothing restricts WHEN in-place critic retry is legal, so two bad moves are available to a self-serving or confused orchestrator:

1. **Verdict-fishing** — retry a critic that already produced a valid `passed: false` on unchanged code, re-rolling until it randomly passes.
2. **Stale-round patching** — retry a critic after code changed (the dev source re-ran, OR an ad-hoc dev job completed), "greening" a round against code that no longer exists. The ad-hoc variant is the hole the maintainer explicitly flagged: the check must consider ANY code-writing completion, not just the source job's retry.

The skill already prescribes the legal move — three-way classifier, `skills/tenet/phases/05-execution-loop.md:114`: "a terminal critic with no valid rubric JSON … is not a pass — retry as-is via tenet_retry_job" — but prompt rules are advisory only (the TASK-037-documented weak-orchestrator family). Verified aggravator: in sequential mode a failed critic stalls all later chained critics (children dispatch only on parent success, `job-manager.ts:520` vs `:525`), which makes the wasteful full re-fire look reasonable to the orchestrator. Fixing that stall's *visibility* is out of scope here.

## Design (maintainer decision, 2026-10-14)

Enforce at the action layer, inside `retryJob` (`src/core/job-manager.ts:303`) — the single choke point — for targets that are critic jobs (carrying `eval_stage` + `source_job_id` params). In-place retry is legal only when BOTH:

1. **No valid verdict exists.** `extractRubricJson` (`src/core/rubric.ts:166`) applied to the target's last stored job output returns null (infra failure: no rubric JSON, context-limit/error exit, empty body). A parsed verdict — red OR green — → refuse. Red's only path forward is the fix loop (retry the dev source, start a fresh full round); green has no reason to re-run.
2. **No code-writing job completed since the round's dispatch.** Round dispatch time = min `createdAt` among siblings sharing the target's `eval_round` (the same round-grouping the gate uses, `job-manager.ts:1090-1104`; siblings via `stateStore.getEvalsForSource` — `state-store.ts:964`). Window = (roundDispatch, now]. Any `dev` or `integration_test` job completed inside it → refuse: source state changed, start a fresh round. (Ad-hoc dev jobs are type `dev`, so they're covered. Eval-type completions — the round's own siblings — must NOT count, or the legal case could never fire.)

Refusals are hard errors naming the legal path; no force flag, no config gate. Fail-closed: if the critic's `eval_round` can't be resolved (legacy/unstamped rows), refuse — never guess. Dev and all non-critic retries unchanged. Release-note as a behavior change (retrying a valid-verdict critic was previously accepted).

## Compatibility with existing doctrine

- The three-way classifier's no-verdict retry stays exactly legal: it happens right after the round, nothing completed in between — both conditions hold by construction. The skill gains a one-line note that the doctrine is now server-enforced.
- The context-limit split path is unaffected: splits create NEW jobs via `tenet_start_job` (`05-execution-loop.md:47`), not `tenet_retry_job`.
- Hand-fired ad-hoc critics are a separate, already-handled surface: unstamped → singleton round → can never green the gate (`job-manager.ts:1074-1083`); forged stamps documented as accepted defense-in-depth (`job-manager.ts:1115-1118`). No new work there.
- The B3 wedge regression (`src/core/integration.test.ts:242`) and the retry tool tests (`src/mcp/tools/tenet-retry-job.test.ts`) must stay green; extend them for the new refusals.

## Related

TASK-007 (critic applicability — `applicable_jobs` roster field) — the other half of the same eval-cost discussion; independent, no ordering between them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Retry of a critic whose last output parses to a verdict (red or green) is refused with an error naming the fix-loop path
- [x] #2 Retry of a no-verdict critic with no dev/integration_test completion since its round dispatch is allowed; the retried critic keeps id/params/eval_round and the patched round greens without sibling re-runs (integration test)
- [x] #3 Retry of a no-verdict critic after ANY dev or integration_test completion in the window (source retry OR ad-hoc dev job) is refused with reason
- [x] #4 Critic with unresolvable eval_round (legacy/unstamped rows) is refused — fail-closed, never guess
- [x] #5 Dev and other non-critic job retry behavior is unchanged (regression)
- [x] #6 Existing round-gate + retry integration tests stay green; new tests lock each distinct refusal reason
- [x] #7 One-line skill note at the classifier (05-execution-loop.md:114) that retry-in-place is server-enforced for no-verdict failures only
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Enforce inside retryJob (job-manager.ts, single choke point; only caller is the MCP tool) for critic jobs (non-empty eval_stage + source_job_id params, same pair the gate uses): (1) last stored output must not parse to a verdict — extractRubricJson + boolean-passed guard (object branch returns any object); red or green both refuse. (2) no dev/integration_test completion in (roundDispatch, now]; roundDispatch = min createdAt of eval_round siblings via getEvalsForSource; missing/unresolvable eval_round = fail-closed refuse. Hard errors name the legal path; no force flag. New StateStore.getCompletedJobsByTypeSince(types, since) with COALESCE(completed_at, created_at). Tests: tenet-retry-job.test.ts locks each refusal reason; integration.test.ts legal end-to-end (round preserved, siblings untouched, round greens); state-store.test.ts for the query. Docs: classifier note in 05-execution-loop.md + one sentence in tool description.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented inside retryJob (job-manager.ts assertCriticRetryLegal, called after the budget check, before resetJobForRetry — refused retries touch no state). Critic detection: non-empty params.eval_stage + source_job_id, the same pair the resume gate uses. Condition 1: extractRubricJson over extractAdapterRawOutput(getJobOutput), guarded by typeof parsed.passed === 'boolean' — extractRubricJson's object branch returns any object, and a structured body without 'passed' is no-verdict by the gate's own standard, so the classifier's retry-as-is stays legal for it. Condition 2: eval_round must be stamped (missing → fail-closed refusal; declared-but-unresolvable round → refusal, defense-in-depth); roundDispatch = min createdAt of the round's siblings via getEvalsForSource; refuse when any dev/integration_test completion (COALESCE(completed_at, created_at)) falls in (roundDispatch, now]. Hard errors name the legal path; no force flag. New StateStore.getCompletedJobsByTypeSince(types, since) — generic query, the dev/integration_test policy stays at the caller.

Found while testing: FakeAdapter serves the fixture body even on success:false and setJobOutput stores output on failed invocations too, so B3/B4/C1b's 'failed' critics carried green-verdict bodies — which the safeguard (correctly) refuses. Their failing rules now serve tests/fixtures/fake-agents/critic-infra-error.md (realistic adapter-level no-verdict body). C1b rewritten from unstamped hand-fired critics to a real startEval-stamped round; it now asserts the full AC#2 contract end-to-end: round preserved, siblings not re-run (retryCount/completedAt untouched), patched round unblocks the blocked parent.

Tests: +9 tenet-retry-job.test.ts (red/green verdict refusals, legal no-verdict retry, structured-no-passed allowed, ad-hoc dev / integration_test / source re-completion in window, dev-before-window legal, unstamped fail-closed), +1 state-store.test.ts (type/status/window filter), C1b rewritten. Docs: 05-execution-loop.md classifier note (server-enforced for no-verdict failures only) + tenet_retry_job description sentence. make check green: 31 files, 391 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Critic retry safeguard enforced at the action layer: tenet_retry_job now refuses verdict re-rolls (red or green) and stale-round patches, each refusal naming the legal path (fix loop / fresh tenet_start_eval round); the three-way classifier's no-verdict retry is now server-enforced, not advisory. Unstamped/legacy critic rows fail closed.
<!-- SECTION:FINAL_SUMMARY:END -->
