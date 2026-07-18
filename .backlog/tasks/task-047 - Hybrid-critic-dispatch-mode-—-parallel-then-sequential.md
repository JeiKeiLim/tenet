---
id: TASK-047
title: Hybrid critic dispatch mode — parallel then sequential
status: To Do
assignee: []
created_date: '2026-07-15 08:02'
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
