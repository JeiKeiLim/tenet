---
id: TASK-035
title: Critics must be mandatory — orchestrator should not skip them
status: To Do
assignee: []
created_date: '2026-07-07 22:11'
updated_date: '2026-07-07 22:12'
labels:
  - bug
  - orchestrator
  - critics
dependencies: []
priority: high
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The orchestrator sometimes skips critics because they hang for a long time, or because most critics passed and many retries happened. The user's stance is clear: critics must ALL pass — they are not optional. Need to enforce this. Restructure job processing with critic gates so the orchestrator cannot proceed until all critics have passed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Orchestrator must wait for all critics to complete before proceeding
- [ ] #2 Orchestrator must not skip critics under any circumstance
- [ ] #3 Explore and decide on critic gate mechanism or tier system
- [ ] #4 Orchestrator must wait for all critics to complete before proceeding
- [ ] #5 Orchestrator must not skip critics under any circumstance
- [ ] #6 Implement critic gate mechanism that blocks job completion until all critics pass
<!-- AC:END -->
