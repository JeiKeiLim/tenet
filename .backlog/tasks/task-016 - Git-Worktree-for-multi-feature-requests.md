---
id: TASK-016
title: Git Worktree for multi-feature requests
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 21:50'
labels: []
dependencies: []
priority: low
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
For multi-feature requests in a single run, use git worktree to spread independent features into separate worktrees, enabling parallel tenet loops. Investigate merge strategy and use-case frequency.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Multi-feature requests are detected and split into independent worktrees
- [ ] #2 Each worktree runs its own tenet loop in parallel
- [ ] #3 Merge strategy for worktree results is defined
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (user decision, backlog cleanup): wont-do. The task's own investigation gate (use-case frequency) was never met - no observed multi-feature request pattern; recent runs were all single-feature, and multi-feature work is handled as multiple sequential runs without felt pain. Architectural cost is high: parallel worktrees would fork the run-artifact set and SQLite state per worktree and require a merge strategy for both, the complexity the one-run-one-feature design deliberately avoids. Within-run DAG concurrency already covers the parallelism that matters, and manual parallelism (two tenet sessions in two worktrees) is not blocked today. Reopen only if real multi-feature demand appears and sequential runs feel like a bottleneck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed as wont-do: no observed multi-feature demand; reopening is cheap if the pattern appears.
<!-- SECTION:FINAL_SUMMARY:END -->
