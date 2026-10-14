---
id: TASK-053
title: Contention steer prescribes a config change no MCP tool can perform
status: Done
assignee: []
created_date: '2026-08-19 00:40'
updated_date: '2026-10-13 00:41'
labels:
  - design
  - eval
dependencies: []
priority: medium
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in the retry PR review loop (round-11, medium): the finding-category dispatch in skills/tenet/phases/05-execution-loop.md adds a contention steer via tenet_add_steer(content='set eval_parallel_safe=false for {feature}', class='context') when a contention finding appears. But eval_parallel_safe:{feature} is only written by the readiness gate (persistReadinessVerdict); no MCP tool (of the 19) can set it, and the orchestrator cannot run the CLI. So the steer is a note the orchestrator cannot act on — the next tenet_start_eval still reads the stale config and parallel contention can recur. Pre-existing (the steer predates the retry PR), not a regression. Fix directions: (a) add a config-set MCP tool (e.g. tenet_set_config or extend tenet_set_agent); (b) make tenet_start_eval accept an explicit execution_mode override; (c) reword the steer to an actionable directive the orchestrator can honor (e.g. 're-run the eval sequentially').
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified): Fixed in PR #22 (commit 0b2a2d2, shipped in 26.9.0) exactly per fix direction (c). Verified at HEAD: the contention steer is now a context note, not a config directive (skills/tenet/phases/05-execution-loop.md:222 - tenet_add_steer with class=context), and the MCP-actionable mechanism is the readiness-gate re-run (persistReadinessVerdict, src/core/job-manager.ts:924-948). Alternatives (a)/(b) were options, not requirements. No ACs/DoD to tick.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed by PR #22 / shipped in 26.9.0: contention steer is a context note and the actionable mechanism is the readiness-gate re-run.
<!-- SECTION:FINAL_SUMMARY:END -->
