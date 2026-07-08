---
id: TASK-036
title: Critic tiers — must / moderate / advisory
status: To Do
assignee: []
created_date: '2026-07-07 22:12'
labels:
  - feature
  - critics
  - orchestrator
dependencies: []
priority: medium
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce critic levels/tiers to give the orchestrator flexibility without skipping mandatory critics. Three tiers: 'must' (blocking — all must pass), 'moderate' (should pass but can proceed with caution), 'advisory' (informational, non-blocking). This allows the orchestrator to make smart decisions about when to proceed while still enforcing hard gates for critical critics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Define critic tier system (must / moderate / advisory)
- [ ] #2 Orchestrator respects tier: 'must' critics are blocking, 'moderate' and 'advisory' are non-blocking
- [ ] #3 Backward compatible — existing critics default to 'must'
<!-- AC:END -->
