---
id: TASK-024
title: Spawned job edge case — context length exceed
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When dispatched job reaches context limit, some agents return error. Critic jobs were accepted as-is with partial result. Delivered (v26.6.7): orchestrator treats context-limit exit as not-passed, retries as-is, then splits into reduced-scope critics after 2 consecutive limits.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Context-limit exit treated as not-passed (retry)
- [ ] #2 Split into reduced-scope critics after 2 consecutive limits
- [ ] #3 Regression test locks the invariant
<!-- AC:END -->
