---
id: TASK-010
title: Worker/critic context size — narrow inlined decomposition
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
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
