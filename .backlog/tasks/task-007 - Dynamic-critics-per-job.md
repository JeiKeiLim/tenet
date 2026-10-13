---
id: TASK-007
title: Critic applicability — per-job applicable_jobs roster filter
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 23:03'
labels:
  - critics
  - eval
  - mcp
  - performance
dependencies: []
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Status (2026-10-14): design converged with the maintainer — re-scoped from "orchestrator chooses critics per job" to declarative per-job applicability. The description below is the standalone implementation spec.**

## Problem (measured)

`tenet_start_eval` dispatches every enabled critic for every job's eval — the roster is project-global (`src/mcp/tools/tenet-start-eval.ts:412-423`). The only per-job signal critics get is the job-scope preamble ("evaluate ONLY this job's scope"); they still all *run*. With 9–11-critic sequential rosters this is the dominant eval cost. Maintainer-reported from real runs (preprod-hardening, Oct 2026): ~69h of critic evals vs ~6h of dev work across 4 jobs; the worst job took 10 fix rounds ≈ 1,600 critic-minutes; one sequential round costs 2–7h wall clock. Domain critics (`alembic_migration_critic`, the credit-ledger/credit-spend critics, `deletion_exhaust_critic`) ran for every job and re-ran on every retry round, even for jobs that never touched their surface.

## Converged design (maintainer decision, 2026-10-14)

- New roster field `applicable_jobs?: string[]` on each `.tenet/critics.json` entry. Missing/empty = applies to all jobs (backwards compatible).
- Match key: decomposition job ids (`F1`, `F2`…) — stored on every registered job as `params.dag_id`. Job UUIDs don't exist yet at tailoring time; job names are editable prose; dag ids are the short stable key authored in `decomposition.md`.
- Filter site: `tenet_start_eval` resolves the source job's `dag_id` and drops non-applicable critics from the dispatch list. `expected_eval_stages` is stamped from what actually dispatched (`tenet-start-eval.ts:426`) and the round gate trusts each round's own stamp (`job-manager.ts:1108-1133`) — so a job whose round runs 4 of 9 critics gates on exactly those 4. **Zero gate changes needed.**
- Ad-hoc jobs (no `params.dag_id`): full roster, fail-safe — non-applicability can't be proven, and the incentive gradient stays uphill (going off-DAG costs *more* critics, never fewer, so ad-hoc creation can't dodge a domain critic). This resolves the ad-hoc open question from the original formulation (old Options A/B/C): the critic declares applicability; ad-hoc jobs get everything.
- Declared at critic tailoring: `skills/tenet/phases/02-spec-and-harness.md` §4.5 gains the instruction (declare `applicable_jobs` keyed by decomposition ids; omit = all). Built-ins ship list-less (conservative default); the mechanism is uniform (any entry may declare).
- Staleness signal: at dispatch, warn (non-fatal) when an entry's `applicable_jobs` references a `dag_id` that no registered job carries — machine-checkable critic-ownership documentation.
- No new exploit surface: the roster is already agent-authored (any critic can be `enabled: false` today); this makes intent declarative instead of deletable.

## Relationship to TASK-048 — dependency LIFTED for this design

The 2026-10-13 audit hard-blocked this task on TASK-048 ("per-job assignment needs a per-run home, not a mutable global file"). The converged design dissolves that premise: applicability is declared on the roster entry itself, and run-scoped entries already live in `.tenet/critics.json` today with a run-end lifecycle (§4.5 prune/promote + the TASK-002 Step 0 orphan sweep). No new per-job artifact is created, so no new home is needed. When TASK-048 lands, run-scoped entries (and their `applicable_jobs` fields) simply move to the run-local roster — the field is home-agnostic; nothing here changes.

## Rejected — do not re-litigate (maintainer decision)

- Scope-glob + git-diff **delta re-eval** (carried verdicts, cumulative-diff tracking, `full_final_round` config): rejected — "re-run all critics when code changed is by design." No diff machinery, no carried verdicts, no opt-in flag.
- **Orchestrator-chosen dynamic critic selection** (the original shape of this task): rejected in favor of declarative filtering — deterministic, lintable, no per-round agent judgment.
- New **partial-launch tool**: rejected — retry-in-place covers infra failures (see the sibling critic-retry-safeguard task), ad-hoc hand-fired critics can add evidence but never green the gate (`job-manager.ts:1074-1083`), and the fix loop re-fires full rounds.

## Implementation map

- `src/core/critic-roster.ts` — `CriticRosterEntry` (:75-97) and `ResolvedCritic` (:100-110): add the optional field; `resolveRoster` (:141-218): validate (array of non-empty strings; invalid entries ignored, critic kept) and pass through; `loadCriticRoster` unchanged.
- `src/mcp/tools/tenet-start-eval.ts` — filter between `loadCriticRoster` (:412) and the dispatch loop; result gains a `skipped_inapplicable` info list (same pattern as `skipped_critics`, :415/:421). Works identically on the parallel and sequential paths (filter is upstream of dispatch-list construction).
- Staleness warning needs the set of all registered `dag_id`s — query jobs via StateStore (add a small query if none exists); compare against every enabled entry's `applicable_jobs`.
- `skills/tenet/phases/02-spec-and-harness.md` §4.5 — tailoring instruction.
- `skills/tenet/critics.md` — authoring-guide documentation for the field.
- Tests: critic-roster unit tests (passthrough / invalid-entry tolerance / default-all); start_eval filter tests (existing test doubles); ad-hoc full-roster integration test; existing round-gate suite as regression.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Roster entries accept `applicable_jobs` (array of decomposition job-id strings); missing/empty = all; invalid entries tolerated (critic kept, bad ids ignored); unit tests cover all three.
- [x] #2 `tenet_start_eval` with source job `dag_id: F1` and roster [A applicable `["F1"]`, B applicable `["F2"]`, C list-less] dispatches A + C only; `expected_eval_stages` = A + C stages; result lists B under `skipped_inapplicable` with reason.
- [x] #3 Source job with no `dag_id` (ad-hoc) → full roster dispatches (fail-safe), integration-tested.
- [x] #4 A filtered round passes the existing round-gate semantics unchanged (existing gate tests green + one new filtered-round case).
- [x] #5 Staleness warning appears in the `tenet_start_eval` result when an entry references a `dag_id` no registered job carries (non-fatal).
- [x] #6 Skill + authoring docs updated: `02-spec-and-harness.md` §4.5 declares the field; `skills/tenet/critics.md` documents it.
- [x] #7 Backwards compat: rosters without the field dispatch identically to today (regression test).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. critic-roster.ts: optional applicable_jobs (string[]) on CriticRosterEntry; resolved applicableJobs (string[]) on ResolvedCritic (missing/empty = all); resolveRoster keeps only non-empty string ids (invalid entries ignored, critic kept). 2. state-store.ts: new getAllDagIds() — distinct params.dag_id across all jobs (staleness-check input). 3. tenet-start-eval.ts: resolve source job dag_id; filter enabled critics (ad-hoc source, no dag_id = full roster, fail-safe); result gains skipped_inapplicable [{id, reason}] + stale_dag_id_warnings (non-fatal); expected_eval_stages stamps from the filtered dispatch list — zero gate changes. 4. Tests: critic-roster unit (passthrough / invalid-entry tolerance / default-all / no-field shape); tenet-start-eval (F1 filter case with expected_eval_stages + skipped_inapplicable, ad-hoc full roster, staleness warning, no-field regression, filtered-round gate case). 5. Docs: 02-spec-and-harness.md §4.5 tailoring instruction + skills/tenet/critics.md field docs. 6. make check; tick ACs 1-7; finalize.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DEPENDENCY (2026-10-13 cleanup audit): infrastructure-blocked on TASK-048 (run-local critic roster + merge) - today tenet_start_eval runs the same enabled roster against every job (src/mcp/tools/tenet-start-eval.ts:412-413). See TASK-048 for the blocking rationale.

2026-10-14 — Design converged after a maintainer discussion prompted by a real-run eval-cost report (~69h critic vs ~6h dev across 4 jobs; worst job 10 rounds ≈ 1,600 critic-minutes). Re-scoped from "planning generates per-job critic descriptions; orchestrator chooses after each job" (old ACs #1/#2) to declarative `applicable_jobs` + deterministic dispatch-time filter — selection is filtering, not agent judgment. The ad-hoc open question (old Options A/B/C) is answered: critic declares applicability; ad-hoc jobs get the full roster, fail-safe. The 2026-10-13 hard block on TASK-048 is lifted — rationale in the description (applicability lives on roster entries, which already have a run-end lifecycle; no new per-job artifact). Priority raised Medium → High on the measured pain. A scope-glob/git-diff delta re-eval proposal from the same discussion was rejected by the maintainer ("re-run all critics when code changed is by design") — see description; do not re-litigate. Sibling task from the same discussion: TASK-056 (critic retry safeguard — enforcement in tenet_retry_job); independent, no ordering.

2026-10-14 — Implemented. critic-roster.ts: applicable_jobs resolves to applicableJobs (non-empty string ids only; invalid entries dropped, critic kept; missing/empty/non-array = all; honored on built-ins, which ship list-less). state-store.ts: new getAllDagIds() (distinct non-empty params.dag_id across all jobs). tenet-start-eval.ts: filter sits between roster load and dispatch-list construction (upstream of the parallel/sequential split); ad-hoc source (no dag_id) gets the full roster fail-safe; result gains skipped_inapplicable [{id, reason}] + stale_dag_id_warnings (non-fatal, DB queried only when an entry declares a list); tool description documents the field. Zero gate changes — expected_eval_stages stamps from the filtered dispatch list. Tests: critic-roster.test.ts +3 (passthrough incl. built-in, invalid-entry tolerance, missing/empty/non-array = all); tenet-start-eval.test.ts +4 (filter case with stamped stages + skipped_inapplicable, ad-hoc full roster, staleness warning, no-field backwards compat); integration.test.ts C26 (filtered 2-stage round unblocks on its own consensus stamp); state-store.test.ts getAllDagIds. Docs: skills/tenet/critics.md (applicable_jobs roster bullet + dispatch line) + 02-spec-and-harness.md §4.5 Step 2 item 3 (declare at tailoring). Validation: make check green — 31 files, 381 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped per-job critic applicability: roster entries accept applicable_jobs (decomposition dag_ids; missing/empty = all jobs), filtered deterministically at tenet_start_eval dispatch; ad-hoc jobs fail-safe to the full roster. Result reports skipped_inapplicable + stale_dag_id_warnings; expected_eval_stages stamps from the filtered list so the round gate needed zero changes (verified by new C26 filtered-round gate test). Docs updated (critics.md authoring bullet, §4.5 tailoring instruction). Verified: make check — 31 files, 381 tests green.
<!-- SECTION:FINAL_SUMMARY:END -->
