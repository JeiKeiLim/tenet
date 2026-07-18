---
id: TASK-035
title: Critics must be mandatory — orchestrator should not skip them
status: To Do
assignee: []
created_date: '2026-07-07 22:11'
updated_date: '2026-07-08 23:28'
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

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-07-08 23:28
---
2026-07-09: as written this task demands ENFORCEMENT (orchestrator 'cannot proceed until all critics pass'). That enforcement was investigated in TASK-037 and deliberately PARKED as premature/oversold (orchestrator is unsandboxed; server-side gating only blocks job-state, not out-of-band work). Shipped instead: a prompt-level delegation recommendation (v26.7.3) where a tracked sub-agent waits on all critics with all-must-pass + three-way classifier invariants - makes skipping far less likely, but is NOT enforcement. The 'enforce / cannot proceed' ACs (#2/#5/#6) are unmet by design. Decision needed: accept the prompt mitigation as the resolution (close), or revisit building the server-side gate (TASK-037 stack).
---
<!-- COMMENTS:END -->
