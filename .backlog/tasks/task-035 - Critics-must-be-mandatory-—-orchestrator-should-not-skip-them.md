---
id: TASK-035
title: Critics must be mandatory — orchestrator should not skip them
status: Done
assignee: []
created_date: '2026-07-07 22:11'
updated_date: '2026-10-13 00:42'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified) as superseded: (1) the server-side enforcement demand was deliberately declined by the parked TASK-037 decision record (orchestrator is unsandboxed, so a job-state gate cannot deliver cannot-proceed; strict all-must-pass blocking was rated brittle). (2) The triggering weak-orchestrator skip behavior is addressed by shipped prompt-level controls (commit e22db9b, verified at HEAD in SKILL.md:178/:185, phases/05-execution-loop.md:103-115, phases/06-evaluation.md:222-223: tracked sub-agent delegation default, all-must-pass, context-limit-is-not-a-pass invariants), with the engine-level all-critics-pass resume gate covering the report-only blocked_on_finding path. (3) The tier-system exploration continues in open TASK-036. REOPEN PATH: if real weak-model failure data ever appears, reopen via TASK-037's recommended shape (critic auto-dispatch + deliverable-quality check), not this task's blocking-gate framing. This resolves the Decision-needed note in the task file.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-07-08 23:28
---
2026-07-09: as written this task demands ENFORCEMENT (orchestrator 'cannot proceed until all critics pass'). That enforcement was investigated in TASK-037 and deliberately PARKED as premature/oversold (orchestrator is unsandboxed; server-side gating only blocks job-state, not out-of-band work). Shipped instead: a prompt-level delegation recommendation (v26.7.3) where a tracked sub-agent waits on all critics with all-must-pass + three-way classifier invariants - makes skipping far less likely, but is NOT enforcement. The 'enforce / cannot proceed' ACs (#2/#5/#6) are unmet by design. Decision needed: accept the prompt mitigation as the resolution (close), or revisit building the server-side gate (TASK-037 stack).
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded: enforcement deliberately declined (TASK-037 record); skip behavior addressed by shipped prompt controls; tier question lives on in TASK-036.
<!-- SECTION:FINAL_SUMMARY:END -->
