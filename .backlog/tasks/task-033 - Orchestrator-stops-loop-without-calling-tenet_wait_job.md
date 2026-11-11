---
id: TASK-033
title: Orchestrator stops loop without calling tenet_wait_job
status: Done
assignee: []
created_date: '2026-07-07 22:11'
updated_date: '2026-11-08 22:18'
labels:
  - bug
  - orchestrator
dependencies: []
priority: high
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When using qwen3.6 27b as orchestrator, it sometimes says it will wait for a job but never calls the tenet_wait_job MCP tool — it just stops doing nothing. This breaks the tenet loop. Need to investigate root cause and find a way to prevent this (e.g. forcing the tool call, adding validation, or restructuring the loop).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Identify root cause of orchestrator skipping tenet_wait_job
- [x] #2 Implement a mechanism to prevent the orchestrator from stopping without calling wait
- [x] #3 Verify fix works with qwen3.6 27b or similar weaker models
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RE-SCOPE (2026-10-13 cleanup audit): ACs #1/#2 are resolved - the delegation-by-default prompt shipped (commit 5a5b315) and is present at HEAD (skills/tenet/phases/05-execution-loop.md:103-118, including the never-tight-loop rule at :15). Only AC#3 remains: one weak-orchestrator run confirming the fix (never collected per TASK-037's final summary). Consider a priority downgrade since the decided fix has shipped.

CLOSE-OUT (2026-11-09 two-pass audit): Both code-verifiable ACs verified shipped at HEAD v26.10.2 — root cause identified (weak orchestrator loses the wait-call in long context; host-boundary problem, MCP has no push mechanism) and the decided fix, delegation-by-default for the wait span, intact at HEAD (skills/tenet/phases/05-execution-loop.md:15,30-32,103-118; skills/tenet/SKILL.md:185; shipped deca3b4 in v26.7.3, made default in 5a5b315 in v26.7.6, verified intact through HEAD). AC#3 satisfied at the project's downscoped evidence bar (TASK-037's 'anecdotal + user confirmation deemed sufficient' decision, plus TASK-012's observed qwen3.6 delegation pattern and cross-CLI feasibility confirmation), not by a dedicated post-fix run. If a future weak-model run shows delegation still not happening, route to the weak-model reliability family with a transcript per TASK-037's measure-first rule.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-07-08 23:28
---
2026-07-09: root cause identified (AC#1) - weak model loses the wait-call in long context; host-boundary problem, no server timer can force a tool call (per TASK-037 audit). Mitigation shipped in v26.7.3: the execution-loop skill now recommends delegating the wait span to a tracked sub-agent, so the wait happens in the sub-agent rather than relying on the main orchestrator remembering to call tenet_job_wait. Advisory, not enforced. AC#3 (verify fix with qwen3.6) remains OPEN - needs a run to confirm prompting makes the non-delegating runs delegate.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fix shipped as skill guidance: delegation-by-default for the wait span (v26.7.3 permit-and-recommend, v26.7.6 default), verified intact at HEAD v26.10.2 by the 2026-11-09 adversarial audit; AC#3 closed at the downscoped evidence bar per TASK-037.
<!-- SECTION:FINAL_SUMMARY:END -->
