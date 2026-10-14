---
id: TASK-010
title: Worker/critic context size — narrow inlined decomposition
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:40'
labels: []
dependencies: []
priority: low
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
v26.7.0 inlines full spec/scenarios/decomposition/harness into every worker and critic. Consider narrowing to current job's slice + dependency interface contracts to save tokens and reduce sibling noise, especially for local-tier runs with finer-grained DAGs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Decomposition inlining is scoped to current job + dependency contracts
- [ ] #2 Token savings are measurable
- [ ] #3 Per-job heading convention or heuristic is established for slicing
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ABSORBED TASK-032 (closed as superseded 2026-10-13): its investigation findings live on in the TASK-032 file (Done status) - two context-assembly paths exist: orchestrator context (tenet_compile_context, src/mcp/tools/tenet-compile-context.ts:126-291) vs worker context (buildWorkerContext, src/core/job-manager.ts:750-804); wasteful patterns: full spec/decomposition/scenarios/harness inlined per worker and per grounded critic, type-agnostic assembly, no size budget; minimal existing filtering: full_context flag, path-referenced bulky docs, steer capping. The 2026-10-13 cleanup audit resolved the mutual-supersession knot between 010 and 032 (each pointed at the other as survivor) in this task's favor: TASK-010 is now the single surviving context-narrowing tracker, gated measure-first by AC#2 per the dial-back contingency recorded at src/core/job-manager.ts:721-725 (commit 2975e33: narrow the inlined decomposition if it proves too much in practice).
<!-- SECTION:NOTES:END -->
