---
id: TASK-015
title: Steer message clarity — orchestrator vs worker
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:42'
labels: []
dependencies: []
priority: medium
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Clarify whether steer messages go to orchestrator, worker, or both. Consider separating steer messages for orchestrator vs worker. Evaluate whether redirect-in-execution is needed and what the role of steer should be.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Steer message routing (orchestrator vs worker) is clearly defined
- [ ] #2 Separate steer channels for orchestrator and worker if needed
- [ ] #3 Redirect-in-execution mechanism evaluated and documented
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SCOPE NOTE (2026-10-13 cleanup audit): orchestrator-only steer routing is decided by consistent implementation (workers never receive steers); remaining work is documentation - an explicit routing statement plus fixing the stale worker-side folding promise at docs/planning/02 §7:293. DROP the sub-step of rewording the contention steer: TASK-053 is fixed (PR #22; skills/tenet/phases/05-execution-loop.md:222). Close as done after the doc edits.
<!-- SECTION:NOTES:END -->
